const { retry } = require("../utils");

const NeteaseCloudMusicApi = require("../../../libraries/audioSource/NeteaseCloudMusicApi")();

module.exports = ({ Artist, Track, TrackList, List, Source, Producer, config }) => {
    class NeteaseCloudMusicApiTrackList extends TrackList {
        _source;
        _playbackQuality;

        constructor(tracks, source, { playbackQuality = 0 } = {}) {
            super(tracks);

            this._source = source;
            this._playbackQuality = playbackQuality;
        }

        async get(index) {
            const track = this._tracks[index];

            if (!track) {
                return null;
            }

            const picture = track.picture || await this._getPicture(track);

            return new Track(String(track.id), track.name, track.duration, track.artists.map((artist) => new Artist(artist.name)), picture, this._source);
        }

        _getPicture() {
            return null;
        }
    }

    return class NeteaseCloudMusicApiProducer extends Producer {
        static get sources() {
            return NeteaseCloudMusicApiProducer._sources;
        }

        static get instances() {
            return NeteaseCloudMusicApiProducer._instances;
        }

        static _sources = [Source.netEase];
        static _instances = config.producers.neteaseCloudMusicApi.instances.map((instance) => new Producer.Instance(instance.host, instance.port, instance.protocol));

        static _listNames = new Map([
            [Source.netEase, ["云音乐热歌榜", "美国Billboard周榜", "日本Oricon周榜", "韩国Mnet排行榜周榜", "台湾Hito排行榜",
                "中国TOP排行榜(内地榜)"]],
        ]);

        _neteaseCloudMusicApi;

        constructor(host, port, protocol) {
            super(host, port, protocol);
            this._neteaseCloudMusicApi = new NeteaseCloudMusicApi(host, port, protocol);
        }

        async search(keywords, source, { playbackQuality = 0, limit, abortSignal } = {}) {
            const proxyPool = this._proxyPool;

            const tracks = (await (async () => {
                try {
                    return await retry(async () => {
                        try {
                            return await this._neteaseCloudMusicApi.searchSongs(keywords, {
                                limit,
                                proxy: proxyPool.getRandomProxy("CN"),
                                abortSignal,
                            });
                        } catch (e) {
                            console.log(e);

                            throw e;
                        }
                    }, proxyPool.getRandomProxy("CN") ? Producer.PROXY_RETRY_TIMES + 1 : 1);
                } catch (e) {
                    console.log(e);

                    try {
                        return await this._neteaseCloudMusicApi.searchSongs(keywords, {
                            limit,
                            abortSignal,
                        });
                    } catch (e) {
                        console.log(e);

                        throw e;
                    }
                }
            })()) || [];

            const getPicture = (track) => this._getPicture(track, abortSignal);

            return new class extends NeteaseCloudMusicApiTrackList {
                async _getPicture(track) {
                    try {
                        return await getPicture(track);
                    } catch {
                        return super._getPicture(track);
                    }
                };
            }(tracks, source, { playbackQuality });
        }

        async getPlaybackSources(id, source, { playbackQuality = 0 } = {}) {
            const playbackSources = await (async () => {
                try {
                    return await retry(async () => {
                        try {
                            return (await this._neteaseCloudMusicApi.getSongURL(id, { proxy: this._proxyPool.getRandomProxy("CN") }))
                                .map((track) => track.url)
                                .filter((url) => url)
                                .map((url) => new Track.PlaybackSource([url], 0));
                        } catch (e) {
                            console.log(e);

                            throw e;
                        }
                    }, this._proxyPool.getRandomProxy("CN") ? Producer.PROXY_RETRY_TIMES + 1 : 1);
                } catch (e) {
                    console.log(e);

                    try {
                        return (await this._neteaseCloudMusicApi.getSongURL(id))
                            .map((track) => track.url)
                            .filter((url) => url)
                            .map((url) => new Track.PlaybackSource([url], 0));
                    } catch (e) {
                        console.log(e);

                        throw e;
                    }
                }
            })();

            // playbackSources.push(...playbackSources.filter((playbackSource) => playbackSource.urls
            //     .reduce((matched, url) => matched || /^\s*http:/.test(url), false))
            //     .map((playbackSource) => new Track.PlaybackSource(playbackSource.urls.map((url) => url.replace(/^\s*http:/, "https:")), {
            //         quality: playbackSource.quality,
            //         statical: playbackSource.statical,
            //         cached: playbackSource.cached,
            //     })));
            //
            // return playbackSources;

            return playbackSources.map((playbackSource) => new Track.PlaybackSource(playbackSource.urls.map((url) => url.replace(/^\s*http:/, "https:")), {
                quality: playbackSource.quality,
                statical: playbackSource.statical,
                cached: playbackSource.cached,
            }));
        }

        async getRecommends(track, source, { playbackQuality = 0, abortSignal }) {
            const tracks = await (async () => {
                if (track) {
                    const matchedTrack = await (await this.search([track.name, ...track.artists.map((artist) => artist.name)].join(","), source, {
                        playbackQuality,
                        limit: 1,
                        abortSignal,
                    })).get(0);

                    return await (async (matchedTrack) => {
                        if (matchedTrack) {
                            try {
                                return await retry(async () => {
                                    try {
                                        return (await this._neteaseCloudMusicApi.getSimiSong(matchedTrack.id, {
                                            proxy: this._proxyPool.getRandomProxy("CN"),
                                            abortSignal,
                                        })) || null;
                                    } catch (e) {
                                        console.log(e);

                                        throw e;
                                    }
                                }, this._proxyPool.getRandomProxy("CN") ? Producer.PROXY_RETRY_TIMES + 1 : 1);
                            } catch (e) {
                                console.log(e);

                                try {
                                    return (await this._neteaseCloudMusicApi.getSimiSong(matchedTrack.id, { abortSignal })) || null;
                                } catch (e) {
                                    console.log(e);

                                    throw e;
                                }
                            }
                        } else {
                            return null;
                        }
                    })(matchedTrack);
                }

                const lists = await this.getLists(source, { abortSignal });
                const randomList = lists[Math.floor(lists.length * Math.random())];

                if (randomList) {
                    return (await this.getList(randomList.id, source, {
                        playbackQuality,
                        abortSignal,
                    })).map((track) => ({
                        id: track.id,
                        name: track.name,
                        duration: track.duration,
                        artists: track.artists.map((artist) => ({ name: artist.name })),
                        picture: track.picture,
                    }));
                }

                return null;
            })();

            if (!tracks || !tracks.length) {
                return await super.getRecommends(track, source, { playbackQuality, abortSignal });
            }

            const getPicture = (track) => this._getPicture(track, { abortSignal });

            const trackList = new class extends NeteaseCloudMusicApiTrackList {
                async _getPicture(track) {
                    try {
                        return await getPicture(track);
                    } catch (e) {
                        return super._getPicture(track);
                    }
                }
            }(tracks, source, { playbackQuality });

            const randomTrack = await trackList.get(Math.floor(trackList.length * Math.random()));

            return randomTrack ? [randomTrack] : null;
        }

        async getLists(source, { abortSignal } = {}) {
            try {
                try {
                    return await retry(async () => {
                        try {
                            return (await this._neteaseCloudMusicApi.getToplist({
                                proxy: this._proxyPool.getRandomProxy("CN"),
                                abortSignal,
                            })).map(({ id, name }) => new List(id, name, source));
                        } catch (e) {
                            console.log(e);

                            throw e;
                        }
                    }, this._proxyPool.getRandomProxy("CN") ? Producer.PROXY_RETRY_TIMES + 1 : 1);
                } catch (e) {
                    console.log(e);

                    try {
                        return (await this._neteaseCloudMusicApi.getToplist({ abortSignal })).map(({ id, name }) => new List(id, name, source));
                    } catch (e) {
                        console.log(e);

                        throw e;
                    }
                }
            } catch {
                return (await Promise.all(NeteaseCloudMusicApiProducer._listNames.get(source)
                    .map(async (listName) => {
                        return (await (async () => {
                            try {
                                return await retry(async () => {
                                    try {
                                        return await this._neteaseCloudMusicApi.searchPlaylist(listName, {
                                            limit: 0,
                                            proxy: proxyPool.getRandomProxy("CN"),
                                            abortSignal,
                                        });
                                    } catch (e) {
                                        console.log(e);

                                        throw e;
                                    }
                                }, this._proxyPool.getRandomProxy("CN") ? Producer.PROXY_RETRY_TIMES + 1 : 1);
                            } catch (e) {
                                console.log(e);

                                try {
                                    return await this._neteaseCloudMusicApi.searchPlaylist(listName, {
                                        limit: 0,
                                        abortSignal,
                                    });
                                } catch (e) {
                                    console.log(e);

                                    throw e;
                                }
                            }
                        })())[0] || null;
                    })))
                    .filter((playlist) => playlist)
                    .map((playlist) => {
                        const { id, name } = playlist;

                        return new List(id, name, source);
                    });
            }
        }

        async getList(id, source, { playbackQuality, limit, offset, abortSignal } = {}) {
            const tracks = await (async () => {
                try {
                    return await retry(async () => {
                        try {
                            return (await this._neteaseCloudMusicApi.getPlaylistDetail(id, {
                                proxy: this._proxyPool.getRandomProxy("CN"),
                                abortSignal,
                            })) || null;
                        } catch (e) {
                            console.log(e);

                            throw e;
                        }
                    }, this._proxyPool.getRandomProxy("CN") ? Producer.PROXY_RETRY_TIMES + 1 : 1);
                } catch (e) {
                    console.log(e);

                    try {
                        return (await this._neteaseCloudMusicApi.getPlaylistDetail(id, { abortSignal })) || null;
                    } catch (e) {
                        console.log(e);

                        throw e;
                    }
                }
            })();

            if (tracks) {
                return tracks.map((track) => new Track(String(track.id), track.name, track.dt, track.ar.map((artist) => new Artist(artist.name)), track.al && track.al.picUrl, source));
            }

            return null;
        }

        async getAlternativeTracks(track, source, { playbackQuality = 0, limit } = {}) {
            return (await this.search([track.name, ...track.artists.map((artist) => artist.name)].join(","), source, { playbackQuality, limit })).values();
        }

        async getTrack(id, source, { playbackQuality = 0 } = {}) {
            const track = await retry(async () => {
                try {
                    return (await this._neteaseCloudMusicApi.getSongDetail([String(id)], { proxy: this._proxyPool.getRandomProxy("CN")}))[0];
                } catch (e) {
                    console.log(e);

                    throw e;
                }
            }, this._proxyPool.getRandomProxy("CN") ? Producer.PROXY_RETRY_TIMES + 1 : 1);

            if (track) {
                const playbackSources = await this.getPlaybackSources(track.id, source);


                return new Track(String(track.id), track.name, track.dt, track.ar.map((artist) => new Artist(artist.name)), (track.al && track.al.picUrl) || undefined, source, playbackSources && playbackSources.length ? playbackSources : undefined);
            }

            return null;
        }

        async _getPicture(track, { abortSignal } = {}) {
            try {
                return await retry(async () => {
                    const details = await (async () => {
                        try {
                            return (await this._neteaseCloudMusicApi.getSongDetail([String(track.id)], {
                                proxy: this._proxyPool.getRandomProxy("CN"),
                                abortSignal,
                            }))[0];
                        } catch (e) {
                            console.log(e);

                            throw e;
                        }
                    })();

                    return (details && details.al && details.al.picUrl && details.al.picUrl.replace(/^\s*http:/, "https:")) || null;
                }, this._proxyPool.getRandomProxy("CN") ? Producer.PROXY_RETRY_TIMES + 1 : 1);
            } catch (e) {
                console.log(e);

                const details = await (async () => {
                    try {
                        return (await this._neteaseCloudMusicApi.getSongDetail([String(track.id)], { abortSignal }))[0];
                    } catch (e) {
                        console.log(e);

                        throw e;
                    }
                })();

                return (details && details.al && details.al.picUrl && details.al.picUrl.replace(/^\s*http:/, "https:")) || null;
            }
        }
    }
};