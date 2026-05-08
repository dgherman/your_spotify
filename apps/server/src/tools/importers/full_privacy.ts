import { readFile, unlink } from "fs/promises";
import { z } from "zod";
import {
	addTrackIdsToUser,
	getCloseTrackId,
	storeFirstListenedAtIfLess,
} from "../../database";
import { setImporterStateCurrent } from "../../database/queries/importer";
import { RecentlyPlayedTrack } from "../../database/schemas/track";
import { User } from "../../database/schemas/user";
import {
	getTracksAlbumsArtists,
	storeTrackAlbumArtist,
} from "../../spotify/dbTools";
import { logger } from "../logger";
import { minOfArray, retryPromise, SpotifyRateLimitError, wait } from "../misc";
import { SpotifyAPI } from "../apis/spotifyApi";
import { Unpack } from "../types";
import { Infos } from "../../database/schemas/info";
import { getFromCacheString, setToCacheString } from "./cache";
import {
	FullPrivacyImporterState,
	HistoryImporter,
	ImporterStateTypes,
} from "./types";

interface ImportStats {
	processed: number;
	stored: number;
	skippedShort: number;
	skippedNoMetadata: number;
	skippedNoSpotifyId: number;
	skippedNotFound: number;
	skippedDuplicate: number;
	cacheHits: number;
}

const fullPrivacyFileSchema = z.array(
	z.object({
		ts: z.string(),
		ms_played: z.number(),
		spotify_track_uri: z.string().nullable(),
		master_metadata_track_name: z.string().nullable(),
		master_metadata_album_artist_name: z.string().nullable(),
	}),
);

export type FullPrivacyItem = Unpack<z.infer<typeof fullPrivacyFileSchema>>;

export class FullPrivacyImporter
	implements HistoryImporter<ImporterStateTypes.fullPrivacy>
{
	private id: string;

	private userId: string;

	private elements: FullPrivacyItem[] | null;

	private currentItem: number;

	private spotifyApi: SpotifyAPI;

	constructor(user: User) {
		this.id = "";
		this.userId = user._id.toString();
		this.elements = null;
		this.currentItem = 0;
		this.spotifyApi = new SpotifyAPI(this.userId);
	}

	static idFromSpotifyURI = (uri: string) => uri.split(":")[2];

	searchByNameArtist = async (
		trackName: string,
		artistName: string,
	) => {
		return retryPromise(
			() => this.spotifyApi.search(trackName, artistName),
			10,
			30,
		);
	};

	storeItems = async (userId: string, items: RecentlyPlayedTrack[]) => {
		const { tracks, albums, artists } = await getTracksAlbumsArtists(
			userId,
			items.map((it) => it.track),
		);
		await storeTrackAlbumArtist({
			tracks,
			albums,
			artists,
		});
		const finalInfos: Omit<Infos, "owner">[] = [];
		for (let i = 0; i < items.length; i += 1) {
			const item = items[i]!;
			const date = new Date(item.played_at);
			const duplicate = await getCloseTrackId(
				this.userId.toString(),
				item.track.id,
				date,
				60,
			);
			const currentImportDuplicate = finalInfos.find(
				(e) => Math.abs(e.played_at.getTime() - date.getTime()) <= 60 * 1000,
			);
			if (duplicate.length > 0 || currentImportDuplicate) {
				logger.info(
					`${item.track.name} - ${item.track.artists[0]?.name} was duplicate`,
				);
				continue;
			}
			const [primaryArtist] = item.track.artists;
			if (!primaryArtist) {
				continue;
			}
			finalInfos.push({
				played_at: date,
				id: item.track.id,
				primaryArtistId: primaryArtist.id,
				albumId: item.track.album.id,
				artistIds: item.track.artists.map((e) => e.id),
				durationMs: item.track.duration_ms,
			});
		}
		await setImporterStateCurrent(this.id, this.currentItem + 1);
		await addTrackIdsToUser(this.userId.toString(), finalInfos);
		const min = minOfArray(finalInfos, (info) => info.played_at.getTime());
		if (min) {
			const minInfo = finalInfos[min.minIndex];
			if (minInfo) {
				await storeFirstListenedAtIfLess(this.userId, minInfo.played_at);
			}
		}
	};

	initWithJSONContent = async (content: any[]) => {
		const value = fullPrivacyFileSchema.safeParse(content);
		if (value.success) {
			this.elements = value.data;
			return content;
		}
		logger.error(
			"If you submitted the right files and this error comes up, please open an issue with the following logs at https://github.com/Yooooomi/your_spotify",
			JSON.stringify(value.error.issues, null, " "),
		);
		return null;
	};

	initWithFiles = async (filePaths: string[]) => {
		const files = await Promise.all(filePaths.map((f) => readFile(f)));
		const filesContent = files.map((f) => JSON.parse(f.toString()));

		const totalContent = filesContent.reduce<FullPrivacyItem[]>((acc, curr) => {
			acc.push(...curr);
			return acc;
		}, []);

		if (!(await this.initWithJSONContent(totalContent))) {
			return false;
		}

		return true;
	};

	init = async (
		existingState: FullPrivacyImporterState | null,
		filePaths: string[],
	) => {
		try {
			this.currentItem = existingState?.current ?? 0;
			const success = await this.initWithFiles(filePaths);
			if (success) {
				return { total: this.elements!.length };
			}
		} catch (e) {
			logger.error(e);
		}
		return null;
	};

	run = async (id: string) => {
		this.id = id;
		if (!this.elements) {
			return false;
		}
		const stats: ImportStats = {
			processed: 0,
			stored: 0,
			skippedShort: 0,
			skippedNoMetadata: 0,
			skippedNoSpotifyId: 0,
			skippedNotFound: 0,
			skippedDuplicate: 0,
			cacheHits: 0,
		};
		let items: RecentlyPlayedTrack[] = [];
		const total = this.elements.length;
		const flushItemsIfNeeded = async (force = false) => {
			if (items.length === 0) {
				return;
			}
			if (!force && items.length < 20) {
				return;
			}
			await this.storeItems(this.userId, items);
			stats.stored += items.length;
			items = [];
		};

		for (let i = this.currentItem; i < total; i += 1) {
			this.currentItem = i;
			stats.processed += 1;
			if (i % 100 === 0) {
				logger.info(`Importing... (${i}/${total})`);
			}
			const content = this.elements[i]!;
			if (
				!content.spotify_track_uri ||
				!content.master_metadata_track_name ||
				!content.master_metadata_album_artist_name
			) {
				stats.skippedNoMetadata += 1;
				continue;
			}
			if (content.ms_played < 30 * 1000) {
				stats.skippedShort += 1;
				continue;
			}
			const spotifyId = FullPrivacyImporter.idFromSpotifyURI(
				content.spotify_track_uri,
			);
			if (!spotifyId) {
				logger.warn(
					`Could not get spotify id from uri: ${content.spotify_track_uri}`,
				);
				stats.skippedNoSpotifyId += 1;
				continue;
			}
			const cached = getFromCacheString(this.userId.toString(), spotifyId);
			if (cached) {
				stats.cacheHits += 1;
				if (cached.exists) {
					items.push({ track: cached.track, played_at: content.ts });
				} else {
					stats.skippedNotFound += 1;
				}
				await flushItemsIfNeeded();
				continue;
			}
			let track;
			try {
				track = await this.searchByNameArtist(
					content.master_metadata_track_name,
					content.master_metadata_album_artist_name,
				);
			} catch (e) {
				if (e instanceof SpotifyRateLimitError) {
					const waitMinutes = Math.ceil(e.retryAfterMs / 60000);
					logger.warn(
						`Rate limited during import, waiting ${waitMinutes} minutes before resuming...`,
					);
					await wait(e.retryAfterMs);
					i -= 1;
					stats.processed -= 1;
					continue;
				}
				throw e;
			}
			if (!track) {
				logger.info(
					`Not found via search: "${content.master_metadata_track_name}" by "${content.master_metadata_album_artist_name}" (uri ${content.spotify_track_uri})`,
				);
				setToCacheString(this.userId.toString(), spotifyId, { exists: false });
				stats.skippedNotFound += 1;
				continue;
			}
			setToCacheString(this.userId.toString(), spotifyId, {
				exists: true,
				track,
			});
			if (track.id !== spotifyId) {
				setToCacheString(this.userId.toString(), track.id, {
					exists: true,
					track,
				});
			}
			items.push({ track, played_at: content.ts });
			logger.info(
				`Adding ${track.name} - ${track.artists[0]?.name} from search`,
			);
			await flushItemsIfNeeded();
		}
		await flushItemsIfNeeded(true);

		logger.info(
			`Import summary: total=${total} processed=${stats.processed} stored=${stats.stored} skippedShort=${stats.skippedShort} skippedNoMetadata=${stats.skippedNoMetadata} skippedNoSpotifyId=${stats.skippedNoSpotifyId} skippedNotFound=${stats.skippedNotFound} skippedDuplicate=${stats.skippedDuplicate} cacheHits=${stats.cacheHits}`,
		);
		return true;
	};

	cleanup = async (filePaths: string[]) => {
		await Promise.all(filePaths.map((f) => unlink(f)));
	};
}
