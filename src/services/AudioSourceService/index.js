const url = require("url");
const dns = require("dns");

const schedule = require("node-schedule");
const stringSimilarity = require("string-similarity");

const RaceManager = require("./RaceManager")();

const TrackListModel = require("../../models/TrackListModel");

module.exports = (env = "development") => {
    const config = require(`./config/${env}`);

    const Artist = require("./Artist")({ config });
    const Track = require("./Track")({ config });
    const TrackList = require("./TrackList")();
    const List = require("./List")({ Track, config });
    const Source = require("./Source")({ TrackList, config });
    const Producer = require("./producers/Producer")({ TrackList });

    const KaiPlanetProducer = require("./producers/KaiPlanetProducer")({ Artist, Track, TrackList, List, Source, Producer, config });
    const NeteaseCloudMusicApiProducer = require("./producers/NeteaseCloudMusicApiProducer")({ Artist, Track, TrackList, List, Source, Producer, config });
    const MusicInterfaceProducer = require("./producers/MusicInterfaceProducer")({ Artist, Track, TrackList, List, Source, Producer, config });
    const MusicApiProducer = require("./producers/MusicApiProducer")({ Artist, Track, TrackList, List, Source, Producer, config });
    const NodeSoundCloudProducer = require("./producers/NodeSoundCloudProducer")({ Artist, Track, TrackList, List, Source, Producer, config });
    const HearthisProducer = require("./producers/HearthisProducer")({ Artist, Track, TrackList, List, Source, Producer, config });
    const KugouMusicApiProducer = require("./producers/KugouMusicApiProducer")({ Artist, Track, TrackList, List, Source, Producer, config });
    const KuGouMobileProducer = require("./producers/KuGouMobileProducer")({ Artist, Track, List, Source, Producer, config });
    const KuGouMobileCDNProducer = require("./producers/KuGouMobileCDNProducer")({ Artist, Track, TrackList, Source, Producer, config });
    const MiguMusicApiProducer = require("./producers/MiguMusicApiProducer")({ Artist, Track, TrackList, List, Source, Producer, config });

    return class AudioSourceService {
        static QUEUE_MAX_SIZE = config.caching.queueMaxSize;
        static Producers = [KaiPlanetProducer, NeteaseCloudMusicApiProducer, MusicInterfaceProducer, KugouMusicApiProducer, MusicApiProducer, KuGouMobileProducer, NodeSoundCloudProducer, HearthisProducer, KuGouMobileCDNProducer, MiguMusicApiProducer];

        static getSources() {
            return Source.values().map((source) => ({
                id: source.id,
                name: source.name,
                icons: source.icons,
            }));
        }

        set cacheService(cacheService) {
            this._cacheService = cacheService;
        }

        set locationService(locationService) {
            this._locationService = locationService;
            this._raceManager.locationService = locationService;
        }

        set proxyPool(proxyPool) {
            this._proxyPool = proxyPool;

            Source.values().forEach((source) => {
                source.producers.forEach((producer) => {
                    producer.proxyPool = proxyPool;
                });
            });

            this._raceManager.proxyPool = proxyPool;
        }

        _cacheService;
        _locationService;
        _proxyPool = { getProxyList() { return null; } };
        _raceManager = new RaceManager();
        _trackCachingQueue = new Set();
        _cachingJobRunning = false;
        _scheduleJobRunning = false;

        constructor() {
            AudioSourceService.Producers.forEach((Producer) => {
                if (Producer.instances && Producer.instances.length) {
                    return Producer.instances.forEach((instance) => {
                        const producer = new Producer(instance.host, instance.port, instance.protocol);

                        Producer.sources.forEach((source) => {
                            source.producers.push(producer);
                        });
                    });
                }

                const producer = new Producer();

                Producer.sources.forEach((source) => {
                    source.producers.push(producer);
                });
            });

            schedule.scheduleJob("0 0 0 * * ?", async () => {
                if (this._scheduleJobRunning) {
                    return;
                }

                this._scheduleJobRunning = true;

                try {
                    await this._cacheTrackLists();
                } catch (e) {
                    console.log(e);
                }

                try {
                    await this._removeOutdatedCache();
                } catch (e) {
                    console.log(e);
                }

                this._scheduleJobRunning = false;
            });
        }

        async getTrack(id, sourceId, { playbackQuality = 0, producerRating } = {}) {
            const source = Source.fromId(sourceId);

            if (!source) {
                return null;
            }

            const track = await source.getTrack(id, { playbackQuality, producerRating });

            if (!track) {
                return null;
            }

            this._addToCachingQueue(track);

            return {
                id: track.id,
                name: track.name,
                duration: track.duration,
                artists: track.artists.map(artist => ({name: artist.name})),
                picture: track.picture,
                source: track.source.id,

                playbackSources: track.playbackSources && track.playbackSources.map((playbackSource) => ({
                    urls: playbackSource.urls,
                    quality: playbackSource.quality,
                    cached: playbackSource.cached,
                    statical: playbackSource.statical,
                })),
            };
        }

        async search(keywords, { sourceIds, limit = 20, sourceRating, producerRating, playbackQuality = 0 } = {}) {
            const sources = ((sourceIds) => {
                if (!sourceIds || !sourceIds.length) {
                    return Source.values();
                }

                return sourceIds.map((sourceId) => Source.fromId(sourceId));
            })(sourceIds);

            const trackLists = await Promise.all(sources.map((source) => (async () => {
                try {
                    return await source.search(keywords, {
                        limit,
                        producerRating,
                        playbackQuality,
                    });
                } catch {
                    return new TrackList();
                }
            })()));

            const trackListLength = trackLists.reduce((total, trackList) => total + trackList.length, 0);

            limit = Math.min(limit, trackListLength);

            const trackPromises = [];
            const len = trackLists.length;

            loop1:for (let i = 0; trackPromises.length < limit; i++) {
                for (let j = 0; j < len; j++) {
                    const trackList = trackLists[j];

                    if (trackPromises.length >= limit) {
                        break loop1;
                    }

                    if (i < trackList.length) {
                        trackPromises.push(trackList.get(i));
                    }
                }
            }

            const tracks = await Promise.all(trackPromises);

            if (!tracks.length) {
                return [];
            }

            this._addToCachingQueue(tracks);

            return stringSimilarity.findBestMatch(keywords, tracks.map(({name}) => name)).ratings
                .map(({ rating }, i) => {
                    const track = tracks[i];

                    const artistsSimilarity = track.artists
                        .map((artist) => stringSimilarity.compareTwoStrings(artist.name, keywords))
                        .reduce((total, rating) => total + rating, 0) / track.artists.length;

                    return {
                        id: track.id,
                        name: track.name,
                        duration: track.duration,
                        artists: track.artists.map(artist => ({name: artist.name})),
                        picture: track.picture,
                        source: track.source.id,

                        playbackSources: track.playbackSources && track.playbackSources.map((playbackSource) => ({
                            urls: playbackSource.urls,
                            quality: playbackSource.quality,
                            cached: playbackSource.cached,
                            statical: playbackSource.statical,
                        })),

                        similarity: Math.min(rating + artistsSimilarity, 1),
                    };
                })
                .sort((a, b) => b.similarity - a.similarity)
                .slice(0, limit);
        }

        async getLists(sourceIds, { limit, offset, sourceRating, producerRating, noCache = false } = {}) {
            if (!Array.isArray(sourceIds) && sourceIds) {
                const source = Source.fromId(sourceIds);

                if (!source) {
                    return null;
                }

                if (!noCache) {
                    try {
                        const docs = await TrackListModel.find({ sourceId: source.id }, "id name").exec();

                        if (!docs || !docs.length) {
                            throw new Error("No doc cached.");
                        }

                        return docs.map((doc) => ({
                            id: doc.id,
                            name: doc.name,
                        }));
                    } catch (e) {
                        console.log(e);
                    }
                }

                const lists = await source.getLists({ limit, offset, producerRating });

                if (!lists) {
                    return null;
                }

                (async () => {
                    try {
                        await this._cacheTrackLists(lists);
                    } catch (e) {
                        console.log(e);
                    }
                })();

                return lists.map((list) => ({
                    id: list.id,
                    name: list.name,
                }));
            }

            const sources = ((sourceIds) => {
                if (!sourceIds || !sourceIds.length) {
                    return Source.values();
                }

                return sourceIds.map((sourceId) => Source.fromId(sourceId));
            })(sourceIds);

            return await Promise.all(sources.map(async (source) => {
                if (!source) {
                    return null;
                }

                if (!noCache) {
                    try {
                        const docs = await TrackListModel.find({ sourceId: source.id }, "id name").exec();

                        if (!docs || !docs.length) {
                            throw new Error("No doc cached.");
                        }

                        return docs.map((doc) => ({
                            id: doc.id,
                            name: doc.name,
                        }));
                    } catch (e) {
                        console.log(e);
                    }
                }

                const lists = await source.getLists({ limit, offset, producerRating });

                if (!lists) {
                    return null;
                }

                this._cacheTrackLists(lists);

                return lists.map((list) => ({
                    id: list.id,
                    name: list.name,
                }));
            }));
        };

        async getList(id, sourceId, { playbackQuality = 0, limit, offset, sourceRating, producerRating, noCache = false } = {}) {
            const source = Source.fromId(sourceId);

            const tracks = await (async () => {
                if (!noCache) {
                    try {
                        const doc = await TrackListModel.findOne({ id, sourceId }, "tracks").exec();

                        if (!doc || !doc.tracks || !doc.tracks.length) {
                            throw new Error("No track cached.");
                        }

                        return doc.tracks.map(({ id, name, duration, artists, picture, playbackSources }) => new Track(id, name, duration, artists, picture, source, (playbackSources && playbackSources.length && playbackSources.map((playbackSource) => new Track.PlaybackSource(playbackSource.urls, {
                            quality: playbackSource.quality,
                            statical: playbackSource.statical,
                            cached: true,
                        }))) || undefined));
                    } catch (e) {
                        console.log(e);
                    }
                }

                return await source.getList(id, { playbackQuality, limit, offset, producerRating });
            })();

            if (!tracks) {
                return null;
            }

            this._addToCachingQueue(tracks);

            return tracks.map((track) => ({
                id: track.id,
                name: track.name,
                duration: track.duration,
                artists: track.artists.map(artist => ({name: artist.name})),
                picture: track.picture,
                source: track.source.id,

                playbackSources: track.playbackSources && track.playbackSources.map((playbackSource) => ({
                    urls: playbackSource.urls,
                    quality: playbackSource.quality,
                    cached: playbackSource.cached,
                    statical: playbackSource.statical,
                })),
            }));
        }

        async getPlaybackSources(id, sourceId, { sourceRating, producerRating, playbackQuality = 0 } = {}) {
            const source = Source.fromId(sourceId);

            if (source) {
                const playbackSources = await source.getPlaybackSources(id, { producerRating, playbackQuality });

                if (!playbackSources || !playbackSources.length) {
                    return null;
                }

                return playbackSources.map((playbackSource) => ({
                    urls: playbackSource.urls,
                    quality: playbackSource.quality,
                    cached: playbackSource.cached,
                    statical: playbackSource.statical,
                }));
            } else {
                return null;
            }
        }

        async getRecommend(track, sourceIds, { playbackQuality = 0, sourceRating, producerRating, retrievePlaybackSource = false, withPlaybackSourceOnly = false } = {}) {
            const sources = ((sourceIds) => {
                if (!sourceIds || !sourceIds.length) {
                    return Source.values();
                }

                return sourceIds.map((sourceId) => Source.fromId(sourceId));
            })(sourceIds);

            const abortController = new AbortController();

            if (!sourceRating) {
                let failCount = 0;
                let err;

                const recommendedTrackPromise = Promise.race(sources.map(async (source) => {
                    try {
                        const recommendedTracks = await (async (track) => {
                            if (track) {
                                const { name, artists } = track;

                                return await source.getRecommends(new Track(undefined, name, undefined, artists.map(artist => new Artist(artist))), {
                                    playbackQuality,
                                    producerRating,
                                    abortSignal: abortController.signal,
                                }) || null;
                            }

                            return await source.getRecommends(null, {
                                playbackQuality,
                                producerRating,
                                abortSignal: abortController.signal,
                            }) || null;
                        })(track);

                        if (recommendedTracks && recommendedTracks.length) {
                            recommendedTracks.sort(() => Math.random() - .5);

                            for (const recommendedTrack of recommendedTracks) {
                                if (recommendedTrack) {
                                    const playbackSources = await (async () => {
                                        if  (recommendedTrack.playbackSources && recommendedTrack.playbackSources.length) {
                                            return recommendedTrack.playbackSources.map((playbackSource) => ({
                                                urls: playbackSource.urls,
                                                quality: playbackSource.quality,
                                                cached: playbackSource.cached,
                                                statical: playbackSource.statical,
                                            }));
                                        }

                                        if (retrievePlaybackSource) {
                                            try {
                                                return await this.getPlaybackSources(recommendedTrack.id, recommendedTrack.source.id, { playbackQuality })
                                            } catch (e) {
                                                console.log(e);
                                            }
                                        }

                                        return null;
                                    })();

                                    if (!withPlaybackSourceOnly || playbackSources && playbackSources.length) {
                                        abortController.abort();

                                        return {
                                            id: recommendedTrack.id,
                                            name: recommendedTrack.name,
                                            duration: recommendedTrack.duration,
                                            artists: recommendedTrack.artists.map(artist => ({name: artist.name})),
                                            picture: recommendedTrack.picture,
                                            source: recommendedTrack.source.id,
                                            playbackSources: playbackSources || undefined,
                                        };
                                    }
                                }
                            }
                        }

                        failCount++;

                        if (failCount >= sources.length) {
                            if (err) {
                                throw err;
                            }

                            return null;
                        }

                        await recommendedTrackPromise;
                    } catch (e) {
                        failCount++;

                        if (failCount >= sources.length) {
                            throw e;
                        }

                        err = e;

                        await recommendedTrackPromise;
                    }
                }));

                if (await recommendedTrackPromise === null && track) {
                    return await this.getRecommend(null, sourceIds, { playbackQuality, sourceRating, producerRating, retrievePlaybackSource, withPlaybackSourceOnly });
                }

                return await recommendedTrackPromise;
            }

            sources.sort(() => Math.random() - .5);

            for (const source of sources) {
                try {
                    const recommendedTracks = await (async (track) => {
                        if (track) {
                            const { name, artists } = track;

                            return await source.getRecommends(new Track(undefined, name, undefined, artists.map(artist => new Artist(artist))), {
                                playbackQuality,
                                producerRating,
                                abortSignal: abortController.signal,
                            }) || null;
                        }

                        return await source.getRecommends(null, {
                            playbackQuality,
                            producerRating,
                            abortSignal: abortController.signal,
                        }) || null;
                    })(track);

                    if (recommendedTracks && recommendedTracks.length) {
                        recommendedTracks.sort(() => Math.random() - .5);

                        for (const recommendedTrack of recommendedTracks) {
                            const playbackSources = await (async () => {
                                if  (recommendedTrack.playbackSources && recommendedTrack.playbackSources.length) {
                                    return recommendedTrack.playbackSources.map((playbackSource) => ({
                                        urls: playbackSource.urls,
                                        quality: playbackSource.quality,
                                        cached: playbackSource.cached,
                                        statical: playbackSource.statical,
                                    }));
                                }

                                if (retrievePlaybackSource) {
                                    try {
                                        return await this.getPlaybackSources(recommendedTrack.id, recommendedTrack.source.id, { playbackQuality })
                                    } catch (e) {
                                        console.log(e);
                                    }
                                }

                                return undefined;
                            })();

                            if (!withPlaybackSourceOnly || playbackSources && playbackSources.length) {
                                abortController.abort();

                                return {
                                    id: recommendedTrack.id,
                                    name: recommendedTrack.name,
                                    duration: recommendedTrack.duration,
                                    artists: recommendedTrack.artists.map(artist => ({name: artist.name})),
                                    picture: recommendedTrack.picture,
                                    source: recommendedTrack.source.id,
                                    playbackSources,
                                };
                            }
                        }
                    }
                } catch (e) {
                    console.log(e);
                }
            }

            return null;
        }

        async getAlternativeTracks(name, artistNames, { playbackQuality = 0, limit = 10, offset, sourceIds, exceptedIds = [], exceptedSourceIds = [], similarityRange, exactMatch = false, sourceRating, producerRating, retrievePlaybackSource = false, withPlaybackSourceOnly = false, timeout } = {}) {
            if (!name || !artistNames) {
                return null;
            }

            const sources = ((sourceIds) => {
                if (!sourceIds || !sourceIds.length) {
                    return Source.values();
                }

                return sourceIds.map((sourceId) => Source.fromId(sourceId));
            })(sourceIds).filter((source) => !exceptedSourceIds.reduce((matched, exceptedSourceId) => matched || source.id === exceptedSourceId, false));

            const tracks = (await Promise.all(sources.map(async (source) => {
                try {
                    return await Promise.race([source.getAlternativeTracks(new Track(undefined, name, undefined, artistNames.map(artistName => new Artist(artistName))), {
                        playbackQuality,
                        limit,
                        producerRating,
                    })].concat(timeout ? new Promise((resolve) => setTimeout(() => resolve(null), timeout)) : []));
                } catch (e) {
                    console.log(e);

                    return null;
                }
            })))
                .flat()
                .filter((matchedTrack) => matchedTrack)
                .filter((matchedTrack) => !exceptedIds.includes(matchedTrack.id));

            if (!tracks.length) {
                return [];
            }

            const fixName = (text) => {
                const parenRegEx = /(:?\(|\uff08)(:?\S|\s)+?(:?\)|\uff09)/g;
                const blankCharRegEx = /\s+/g;

                return text.replace(parenRegEx, "").replace(blankCharRegEx, "").toLowerCase();
            };

            const altTracks = stringSimilarity.findBestMatch(fixName(name), tracks.map(({ name }) => fixName(name))).ratings
                .map(({ rating }, i) => {
                    const track = tracks[i];

                    const artistsSimilarity = track.artists
                        .map((artist) => stringSimilarity.findBestMatch(fixName(artist.name), artistNames.map((artistName) => fixName(artistName))).bestMatch.rating)
                        .reduce((total, rating) => total + rating, 0) / track.artists.length;

                    const similarity = rating * .6 + artistsSimilarity * .4;

                    if (exactMatch && similarity < 1) {
                        return null;
                    }

                    if (similarityRange) {
                        if (typeof similarityRange.high !== "undefined" && similarity > similarityRange.high) {
                            return null;
                        }

                        if (typeof similarityRange.low !== "undefined" && similarity < similarityRange.low) {
                            return null;
                        }

                        if (typeof similarityRange.high !== "undefined" && typeof similarityRange.low !== "undefined" && +similarityRange.high < +similarityRange.low) {
                            return null;
                        }
                    }

                    return {
                        id: track.id,
                        name: track.name,
                        duration: track.duration,
                        artists: track.artists.map(artist => ({name: artist.name})),
                        picture: track.picture,
                        source: track.source.id,

                        playbackSources: (track.playbackSources && track.playbackSources.length && track.playbackSources.map((playbackSource) => ({
                            urls: playbackSource.urls,
                            quality: playbackSource.quality,
                            cached: playbackSource.cached,
                            statical: playbackSource.statical,
                        }))) || undefined,

                        similarity,
                    };
                })
                .filter((track) => track)
                .sort((a, b) => b.similarity - a.similarity)
                .slice(0, limit);

            if (retrievePlaybackSource) {
                await Promise.all(altTracks.map(async (track) => {
                    if (!track.playbackSources) {
                        track.playbackSources = (await (async () => {
                            try {
                                return await this.getPlaybackSources(track.id, track.source, { playbackQuality })
                            } catch (e) {
                                console.log(e);
                            }
                        })()) || undefined;
                    }

                    return track;
                }));
            }

            if (withPlaybackSourceOnly) {
                return altTracks.filter((altTrack) => altTrack.playbackSources && altTrack.playbackSources.length);
            }

            return altTracks;
        }

        async getStream(id, sourceId, { quality ,timeToWait, alternativeTracks = {} } = {}) {
            const { track, sourceIds, exceptedSourceIds, similarityRange, exactMatch } = alternativeTracks;

            const { name, artistNames } = await (async (track) => {
                if (!track) {
                    track = await this.getTrack(id, sourceId);
                }

                if (!track) {
                    return {};
                }

                return track;
            })(track);

            const altTracksPromises = (name && artistNames) ? AudioSourceService.getSources()
                .filter((source) => source.id !== sourceId)
                .filter((source) => sourceIds.includes(source.id))
                .filter((source) => !exceptedSourceIds.includes(source.id))
                .map((source) => this.getAlternativeTracks(name, artistNames, {
                    playbackQuality: quality,
                    sourceIds: [source.id],
                    similarityRange,
                    exactMatch,
                })) : [];

            const playbackSources = await this.getPlaybackSources(id, sourceId, { playbackQuality: quality });

            let raceEnded = false;

            const racePromise = this._raceManager.startRace();

            if (playbackSources) {
                for (const playbackSource of playbackSources) {
                    this._raceManager.joinRace(playbackSource.urls, timeToWait * Math.abs(playbackSource.quality - quality));
                }
            }

            setTimeout(async () => {
                if (raceEnded === true) {
                    return;
                }

                for(const altTrack of (await altTracksPromises)) {
                    if (!altTrack.playbackSources || !altTrack.playbackSources.length) {
                        altTrack.playbackSources = this.getPlaybackSources(altTrack.id, altTrack.source, { playbackQuality: quality });
                    }

                    for (const playbackSource of altTrack.playbackSources) {
                        this._raceManager.joinRace(playbackSource.urls, timeToWait * Math.abs(playbackSource.quality - quality));
                    }

                    this._raceManager.stopJoinRace();
                }
            }, timeToWait);

            if (!this._raceManager.racerNum) {
                return null;
            }

            const stream = await racePromise;

            raceEnded = true;

            return stream;
        }

        _addToCachingQueue(tracks) {
            if (this._trackCachingQueue.size >= AudioSourceService.QUEUE_MAX_SIZE) {
                return;
            }

            if (!Array.isArray(tracks)) {
                this._trackCachingQueue.add(tracks);
            } else {
                for (const track of tracks) {
                    this._trackCachingQueue.add(track);
                }
            }

            this._runCachingJob();
        }

        async _runCachingJob() {
            if (this._cachingJobRunning) {
                return;
            }

            this._cachingJobRunning = true;

            while (true) {
                if (!this._trackCachingQueue.size) {
                    break;
                }

                const track = this._trackCachingQueue.values().next().value;

                this._trackCachingQueue.delete(track);

                try {
                    await this._cacheTrack(track);
                } catch (e) {
                    console.log(e);
                }

                await new Promise((resolve) => setTimeout(resolve, config.caching.coolDownTime));
            }

            this._cachingJobRunning = false;
        }

        async _cacheTrack(track) {
            const streamUrls = (await (async () => {
                const playbackSources = await (async () => {
                    if (track.playbackSources) {
                        return track.playbackSources;
                    }

                    return await this.getPlaybackSources(track.id, track.source.id);
                })();

                return playbackSources.map((playbackSource) => playbackSource.urls).flat();
            })()).map((streamUrl) => {
                const fixedUrl = ((url) => {
                    if (!/:/.test(url)) {
                        return 'https://' + url;
                    }

                    return url;
                })(streamUrl.replace(/^\/+/, '').replace(/\/+$/, ''));

                return url.parse(fixedUrl);
            });

            for (const streamUrl of streamUrls) {
                if (this._cacheService.exists(streamUrl.href)) {
                    return;
                }

                try {
                    await this._cacheService.cache(streamUrl.href, await this._cacheService.sendRequest(streamUrl, "GET", { timeout: config.caching.timeout }), { transmissionRate: config.caching.transmissionRate });
                } catch (e) {
                    console.log(e);

                    const proxies = await (async (url) => {
                        const ip = await new Promise((resolve, reject) => {
                            dns.lookup(url.host, (err, address) => {
                                if (err) {
                                    reject(err);
                                }

                                resolve(address);
                            });
                        });

                        const location = await this._locationService.getLocation(ip);

                        return this._proxyPool.getProxyList(location.areaCode);
                    })(streamUrl);

                    for (const proxy of proxies) {
                        try {
                            await this._cacheService.cache(streamUrl.href, await this._cacheService.sendRequest(streamUrl, "GET", {
                                proxy,
                                timeout: config.caching.timeout,
                            }), { transmissionRate: config.caching.transmissionRate });

                            break;
                        } catch (e) {
                            console.log(e);
                        }
                    }
                }
            }
        }

        async _cacheTrackLists(lists) {
            if (lists && Array.isArray(lists) && lists[0] instanceof List) {
                for (const list of lists) {
                    try {
                        const tracks = await this.getList(list.id, list.source.id, { noCache: true });

                        for (const track of tracks) {
                            if (!track.playbackSources || !track.playbackSources.length) {
                                try {
                                    track.playbackSources = await this.getPlaybackSources(track.id, track.source.id) || undefined;
                                } catch (e) {
                                    console.log(e);
                                }
                            }

                            if (!track.playbackSources || !track.playbackSources.length) {
                                track.playbackSources = undefined;
                            }
                        }
                        try {
                            await TrackListModel.createOrUpdate({
                                id: list.id,
                                sourceId: list.source.id,
                            }, {
                                id: list.id,
                                sourceId: list.source.id,
                                name: list.name,
                                tracks: tracks,
                                updatedOn: new Date(),
                            });
                        } catch (e) {
                            console.log(e);
                        }
                    } catch (e) {
                        console.log(e);
                    }
                }

                return;
            }

            const sources = AudioSourceService.getSources();

            for (const source of sources) {
                try {
                    const lists = await this.getLists(source.id, { noCache: true });

                    for (const list of lists) {
                        try {
                            const tracks = await this.getList(list.id, source.id, { noCache: true });

                            for (const track of tracks) {
                                if (!track.playbackSources || !track.playbackSources.length) {
                                    try {
                                        track.playbackSources = await this.getPlaybackSources(track.id, track.source.id);
                                    } catch (e) {
                                        console.log(e);
                                    }
                                }

                                if (!track.playbackSources || !track.playbackSources.length) {
                                    track.playbackSources = undefined;
                                }
                            }

                            try {
                                await TrackListModel.createOrUpdate({
                                    id: list.id,
                                    sourceId: source.id,
                                }, {
                                    id: list.id,
                                    sourceId: source.id,
                                    name: list.name,
                                    tracks: tracks,
                                    updatedOn: new Date(),
                                });
                            } catch (e) {
                                console.log(e);
                            }

                            await new Promise((resolve) => setTimeout(resolve, config.caching.coolDownTime));
                        } catch (e) {
                            console.log(e);
                        }
                    }
                } catch (e) {
                    console.log(e);
                }
            }
        }

        async _removeOutdatedCache() {
            try {
                const date = new Date();

                await TrackListModel.deleteMany({
                    updatedOn: {
                        $lt: new Date(date.getTime() - config.caching.expiresAfter),
                    },
                }).exec();
            } catch (e) {
                console.log(e);
            }
        }
    }
};