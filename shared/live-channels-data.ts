/**
 * Live news channel + webcam feed registries.
 *
 * Lives in `shared/` — not in the panel components that render them — because
 * the iOS bundle endpoint (`api/ios-bundle.ts` → `server/_shared/ios-bundle.ts`)
 * serves the same tables to the mobile client, and `server/` must not import
 * `src/components/` (AGENTS.md architecture invariants). The panels re-export
 * these names so their existing importers are unchanged.
 *
 * Same pattern as `shared/geo-data.ts` / `shared/pipelines-data.ts`: dependency-free
 * data here, DOM/theme behaviour stays in the component.
 */

export interface LiveChannel {
  id: string;
  name: string;
  handle?: string; // YouTube channel handle (e.g., @bloomberg) - optional for HLS streams
  fallbackVideoId?: string; // Fallback if no live stream detected
  videoId?: string; // Dynamically fetched live video ID
  isLive?: boolean;
  hlsUrl?: string; // HLS manifest URL for native <video> playback (desktop)
  useFallbackOnly?: boolean; // Skip auto-detection, always use fallback
  geoAvailability?: string[]; // ISO 3166-1 alpha-2 codes; undefined = available everywhere
}

// Full variant: World news channels (24/7 live streams)
export const FULL_LIVE_CHANNELS: LiveChannel[] = [
  { id: 'bloomberg', name: 'Bloomberg', handle: '@markets', fallbackVideoId: 'iEpJwprxDdk' },
  { id: 'sky', name: 'SkyNews', handle: '@SkyNews', fallbackVideoId: 'uvviIF4725I' },
  { id: 'euronews', name: 'Euronews', handle: '@euronews', fallbackVideoId: 'pykpO5kQJ98' },
  { id: 'dw', name: 'DW', handle: '@DWNews', fallbackVideoId: 'LuKwFajn37U' },
  { id: 'cnbc', name: 'CNBC', handle: '@CNBC', fallbackVideoId: '9NyxcX3rhQs' },
  { id: 'cnn', name: 'CNN', handle: '@CNN', fallbackVideoId: 'w_Ma8oQLmSM' },
  { id: 'france24', name: 'France 24', handle: '@FRANCE24', fallbackVideoId: 'u9foWyMSETk' },
  { id: 'alarabiya', name: 'AlArabiya', handle: '@AlArabiya', fallbackVideoId: 'n7eQejkXbnM', useFallbackOnly: true },
  { id: 'aljazeera', name: 'AlJazeera', handle: '@AlJazeeraEnglish', fallbackVideoId: 'gCNeDWCI0vo', useFallbackOnly: true },
];

// Tech variant: Tech & business channels
export const TECH_LIVE_CHANNELS: LiveChannel[] = [
  { id: 'bloomberg', name: 'Bloomberg', handle: '@markets', fallbackVideoId: 'iEpJwprxDdk' },
  { id: 'yahoo', name: 'Yahoo Finance', handle: '@YahooFinance', fallbackVideoId: 'KQp-e_XQnDE' },
  { id: 'cnbc', name: 'CNBC', handle: '@CNBC', fallbackVideoId: '9NyxcX3rhQs' },
  { id: 'nasa', name: 'Sen Space Live', handle: '@NASA', fallbackVideoId: 'aB1yRz0HhdY', useFallbackOnly: true },
];

// Optional channels users can add from the "Available Channels" tab UI
// Includes default channels so they appear in the grid for toggle on/off
export const OPTIONAL_LIVE_CHANNELS: LiveChannel[] = [
  // North America (defaults first)
  { id: 'bloomberg', name: 'Bloomberg', handle: '@markets', fallbackVideoId: 'iEpJwprxDdk' },
  { id: 'cnbc', name: 'CNBC', handle: '@CNBC', fallbackVideoId: '9NyxcX3rhQs' },
  { id: 'yahoo', name: 'Yahoo Finance', handle: '@YahooFinance', fallbackVideoId: 'KQp-e_XQnDE' },
  { id: 'cnn', name: 'CNN', handle: '@CNN', fallbackVideoId: 'w_Ma8oQLmSM' },
  { id: 'fox-news', name: 'Fox News', handle: '@FoxNews', fallbackVideoId: 'QaftgYkG-ek' },
  { id: 'newsmax', name: 'Newsmax', handle: '@NEWSMAX', fallbackVideoId: 'S-lFBzloL2Y', useFallbackOnly: true },
  { id: 'abc-news', name: 'ABC News', handle: '@ABCNews' },
  { id: 'cbs-news', name: 'CBS News', handle: '@CBSNews', fallbackVideoId: 'R9L8sDK8iEc' },
  { id: 'nbc-news', name: 'NBC News', handle: '@NBCNews', fallbackVideoId: 'yMr0neQhu6c' },
  { id: 'cbc-news', name: 'CBC News', handle: '@CBCNews', fallbackVideoId: 'jxP_h3V-Dv8' },
  { id: 'ctv-news', name: 'CTV News', hlsUrl: 'https://pe-fa-lp02a.9c9media.com/live/News1Digi/p/hls/00000201/38ef78f479b07aa0/index/0c6a10a2/live/stream/h264/v1/3500000/manifest.m3u8', useFallbackOnly: true },
  { id: 'reuters-tv', name: 'Reuters TV', hlsUrl: 'https://reuters-reutersnow-1-eu.rakuten.wurl.tv/playlist.m3u8', useFallbackOnly: true },
  { id: 'nasa', name: 'Sen Space Live', handle: '@NASA', fallbackVideoId: 'aB1yRz0HhdY', useFallbackOnly: true },
  // Europe (defaults first)
  { id: 'sky', name: 'SkyNews', handle: '@SkyNews', fallbackVideoId: 'uvviIF4725I' },
  { id: 'euronews', name: 'Euronews', handle: '@euronews', fallbackVideoId: 'pykpO5kQJ98' },
  { id: 'dw', name: 'DW', handle: '@DWNews', fallbackVideoId: 'LuKwFajn37U' },
  { id: 'france24', name: 'France 24', handle: '@FRANCE24', fallbackVideoId: 'u9foWyMSETk' },
  { id: 'bbc-news', name: 'BBC News', handle: '@BBCNews', fallbackVideoId: 'bjgQzJzCZKs' },
  { id: 'gb-news', name: 'GB News', hlsUrl: 'https://live-gbnews.simplestreamcdn.com/live5/gbnews/bitrate1.isml/manifest.m3u8', useFallbackOnly: true },
  { id: 'the-guardian', name: 'The Guardian', hlsUrl: 'https://rakuten-guardian-1-ie.samsung.wurl.tv/playlist.m3u8', useFallbackOnly: true },
  { id: 'france24-en', name: 'France 24 English', handle: '@France24_en', fallbackVideoId: 'Ap-UM1O9RBU' },
  { id: 'rtve', name: 'RTVE 24H', handle: '@RTVENoticias', fallbackVideoId: '7_srED6k0bE' },
  { id: 'phoenix', name: 'Phoenix', hlsUrl: 'https://zdf-hls-19.akamaized.net/hls/live/2016502/de/veryhigh/master.m3u8', useFallbackOnly: true, geoAvailability: ['DE', 'AT', 'CH'] },
  { id: 'rtp3', name: 'RTP3', hlsUrl: 'https://streaming-live.rtp.pt/livetvhlsDVR/rtpnHDdvr.smil/playlist.m3u8?DVR=', useFallbackOnly: true, geoAvailability: ['PT', 'BR'] },
  { id: 'trt-haber', name: 'TRT Haber', handle: '@trthaber', fallbackVideoId: '3XHebGJG0bc' },
  { id: 'ntv-turkey', name: 'NTV', handle: '@NTV', fallbackVideoId: 'pqq5c6k70kk' },
  { id: 'cnn-turk', name: 'CNN TURK', handle: '@cnnturk', fallbackVideoId: 'lsY4GFoj_xY' },
  { id: 'tv-rain', name: 'TV Rain', handle: '@tvrain' },
  { id: 'rt', name: 'RT', hlsUrl: 'https://rt-glb.rttv.com/dvr/rtnews/playlist.m3u8', useFallbackOnly: true },
  { id: 'tvp-info', name: 'TVP Info', handle: '@tvpinfo', fallbackVideoId: '3jKb-uThfrg' },
  { id: 'telewizja-republika', name: 'Telewizja Republika', handle: '@Telewizja_Republika', fallbackVideoId: 'dzntyCTgJMQ' },
  // Latin America & Portuguese
  { id: 'cnn-brasil', name: 'CNN Brasil', handle: '@CNNbrasil', fallbackVideoId: 'qcTn899skkc' },
  { id: 'jovem-pan', name: 'Jovem Pan News', handle: '@jovempannews' },
  { id: 'record-news', name: 'Record News', handle: '@RecordNews', hlsUrl: 'https://stream.ads.ottera.tv/playlist.m3u8?network_id=2116' },
  { id: 'band-jornalismo', name: 'Band Jornalismo', handle: '@BandJornalismo' },
  { id: 'tn-argentina', name: 'TN (Todo Noticias)', handle: '@todonoticias', fallbackVideoId: 'cb12KmMMDJA' },
  { id: 'c5n', name: 'C5N', handle: '@c5n', fallbackVideoId: 'SF06Qy1Ct6Y' },
  { id: 'milenio', name: 'MILENIO', handle: '@MILENIO' },
  { id: 'noticias-caracol', name: 'Noticias Caracol', handle: '@NoticiasCaracol' },
  { id: 'ntn24', name: 'NTN24', handle: '@NTN24' },
  { id: 't13', name: 'T13', handle: '@Teletrece' },
  { id: 'dw-espanol', name: 'DW Español', hlsUrl: 'https://dwamdstream104.akamaized.net/hls/live/2015530/dwstream104/stream04/streamPlaylist.m3u8', useFallbackOnly: true },
  { id: 'rt-espanol', name: 'RT Español', hlsUrl: 'https://rt-esp.rttv.com/dvr/rtesp/playlist.m3u8', useFallbackOnly: true },
  { id: 'cgtn-espanol', name: 'CGTN Español', hlsUrl: 'https://news.cgtn.com/resource/live/espanol/cgtn-e.m3u8', useFallbackOnly: true },
  // Asia
  { id: 'tbs-news', name: 'TBS NEWS DIG', handle: '@tbsnewsdig', fallbackVideoId: 'aUDm173E8k8' },
  { id: 'ann-news', name: 'ANN News', handle: '@ANNnewsCH' },
  { id: 'ntv-news', name: 'NTV News (Japan)', handle: '@ntv_news' },
  { id: 'cti-news', name: 'CTI News (Taiwan)', handle: '@中天新聞CtiNews' },
  { id: 'wion', name: 'WION', handle: '@WION' },
  { id: 'ndtv', name: 'NDTV 24x7', handle: '@NDTV' },
  { id: 'cgtn', name: 'CGTN', hlsUrl: 'https://news.cgtn.com/resource/live/english/cgtn-news.m3u8', useFallbackOnly: true },
  { id: 'cna-asia', name: 'CNA (NewsAsia)', handle: '@channelnewsasia', fallbackVideoId: 'XWq5kBlakcQ' },
  { id: 'nhk-world', name: 'NHK World Japan', handle: '@NHKWORLDJAPAN', fallbackVideoId: 'f0lYfG_vY_U' },
  { id: 'arirang-news', name: 'Arirang News', handle: '@ArirangCoKrArirangNEWS', hlsUrl: 'https://amdlive-ch01-ctnd-com.akamaized.net/arirang_1ch/smil:arirang_1ch.smil/playlist.m3u8' },
  { id: 'india-today', name: 'India Today', handle: '@indiatoday', fallbackVideoId: 'sYZtOFzM78M' },
  { id: 'abp-news', name: 'ABP News', handle: '@ABPNews', hlsUrl: 'https://abplivetv.pc.cdn.bitgravity.com/httppush/abp_livetv/abp_abpnews/master.m3u8' },
  // Middle East (defaults first)
  { id: 'alarabiya', name: 'AlArabiya', handle: '@AlArabiya', fallbackVideoId: 'n7eQejkXbnM', useFallbackOnly: true },
  { id: 'aljazeera', name: 'AlJazeera', handle: '@AlJazeeraEnglish', fallbackVideoId: 'gCNeDWCI0vo', useFallbackOnly: true },
  { id: 'al-hadath', name: 'Al Hadath', handle: '@AlHadath', fallbackVideoId: 'xWXpl7azI8k', useFallbackOnly: true },
  { id: 'sky-news-arabia', name: 'Sky News Arabia', handle: '@skynewsarabia', fallbackVideoId: 'U--OjmpjF5o' },
  { id: 'trt-world', name: 'TRT World', handle: '@TRTWorld', fallbackVideoId: 'ABfFhWzWs0s' },
  { id: 'iran-intl', name: 'Iran International', handle: '@IranIntl' },
  { id: 'cgtn-arabic', name: 'CGTN Arabic', handle: '@CGTNArabic' },
  { id: 'kan-11', name: 'Kan 11', handle: '@KAN11NEWS', fallbackVideoId: 'TCnaIE_SAtM' },
  { id: 'i24-news', name: 'i24NEWS (Israel)', handle: '@i24NEWS_HE', fallbackVideoId: 'myKybZUK0IA' },
  { id: 'asharq-news', name: 'Asharq News', handle: '@asharqnews', fallbackVideoId: 'f6VpkfV7m4Y', useFallbackOnly: true },
  { id: 'aljazeera-arabic', name: 'AlJazeera Arabic', handle: '@AljazeeraChannel', fallbackVideoId: 'bNyUyrR0PHo', useFallbackOnly: true },
  { id: 'aljazeera-mubasher', name: 'Al Jazeera Mubasher', hlsUrl: 'https://live-hls-web-ajm.getaj.net/AJM/index.m3u8', useFallbackOnly: true },
  { id: 'alarabiya-business', name: 'Al Arabiya Business', hlsUrl: 'https://live.alarabiya.net/alarabiapublish/aswaaq.smil/playlist.m3u8', useFallbackOnly: true },
  { id: 'al-qahera-news', name: 'Al Qahera News', hlsUrl: 'https://bcovlive-a.akamaihd.net/d30cbb3350af4cb7a6e05b9eb1bfd850/eu-west-1/6057955906001/playlist.m3u8', useFallbackOnly: true },
  { id: 'press-tv', name: 'Press TV', hlsUrl: 'https://cdnlive.presstv.ir/cdnlive/smil:cdnlive.smil/playlist.m3u8', useFallbackOnly: true },
  { id: 'dw-arabic', name: 'DW Arabic', hlsUrl: 'https://dwamdstream103.akamaized.net/hls/live/2015526/dwstream103/index.m3u8', useFallbackOnly: true },
  { id: 'rt-arabic', name: 'RT Arabic', hlsUrl: 'https://rt-arb.rttv.com/dvr/rtarab/playlist.m3u8', useFallbackOnly: true },
  { id: 'rudaw', name: 'Rudaw', hlsUrl: 'https://svs.itworkscdn.net/rudawlive/rudawlive.smil/playlist.m3u8', useFallbackOnly: true },
  // Africa
  { id: 'africanews', name: 'Africanews', handle: '@africanews' },
  { id: 'channels-tv', name: 'Channels TV', handle: '@ChannelsTelevision' },
  { id: 'ktn-news', name: 'KTN News', handle: '@ktnnews_kenya', fallbackVideoId: 'RmHtsdVb3mo' },
  { id: 'enca', name: 'eNCA', handle: '@encanews' },
  { id: 'sabc-news', name: 'SABC News', handle: '@SABCDigitalNews', hlsUrl: 'https://sabconetanw.cdn.mangomolo.com/news/smil:news.stream.smil/playlist.m3u8' },
  { id: 'arise-news', name: 'Arise News', handle: '@AriseNewsChannel', fallbackVideoId: '4uHZdlX-DT4' },
  // Europe (additional)
  { id: 'welt', name: 'WELT', handle: '@WELTVideoTV', fallbackVideoId: 'L-TNmYmaAKQ', geoAvailability: ['DE', 'AT', 'CH'] },
  { id: 'tagesschau24', name: 'Tagesschau24', handle: '@tagesschau', fallbackVideoId: 'fC_q9TkO1uU' },
  { id: 'euronews-fr', name: 'Euronews FR', handle: '@euronewsfr', fallbackVideoId: 'NiRIbKwAejk' },
  { id: 'euronews-gr', name: 'Euronews GR', handle: '@euronewsgr' },
  { id: 'skai-tv', name: 'SKAI TV', handle: '@skaitv' },
  { id: 'ert-news', name: 'ERT News', handle: '@ertgr', hlsUrl: 'https://ertflix.ascdn.broadpeak.io/ertlive/ertnews/default/index.m3u8', useFallbackOnly: true },
  { id: 'france24-fr', name: 'France 24 FR', handle: '@France24_fr', fallbackVideoId: 'l8PMl7tUDIE' },
  { id: 'france-info', name: 'France Info', handle: '@franceinfo', fallbackVideoId: 'Z-Nwo-ypKtM' },
  { id: 'bfmtv', name: 'BFMTV', handle: '@BFMTV', fallbackVideoId: 'smB_F6DW7cI' },
  { id: 'tv5monde-info', name: 'TV5 Monde Info', handle: '@TV5MONDEInfo', hlsUrl: 'https://ott.tv5monde.com/Content/HLS/Live/channel(info)/index.m3u8', geoAvailability: ['FR', 'BE', 'CH', 'CA'] },
  { id: 'nrk1', name: 'NRK1', handle: '@nrk', hlsUrl: 'https://nrk-nrk1.akamaized.net/21/0/hls/nrk_1/playlist.m3u8', geoAvailability: ['NO'] },
  { id: 'aljazeera-balkans', name: 'Al Jazeera Balkans', handle: '@AlJazeeraBalkans', hlsUrl: 'https://live-hls-web-ajb.getaj.net/AJB/index.m3u8' },
  // Oceania
  { id: 'abc-news-au', name: 'ABC News Australia', handle: '@abcnewsaustralia', fallbackVideoId: 'vOTiJkg1voo' },
];

const _REGION_ENTRIES: { key: string; labelKey: string; channelIds: string[] }[] = [
  { key: 'na', labelKey: 'components.liveNews.regionNorthAmerica', channelIds: ['bloomberg', 'cnbc', 'yahoo', 'cnn', 'fox-news', 'newsmax', 'abc-news', 'cbs-news', 'nbc-news', 'cbc-news', 'ctv-news', 'reuters-tv', 'nasa'] },
  { key: 'eu', labelKey: 'components.liveNews.regionEurope', channelIds: ['sky', 'euronews', 'dw', 'france24', 'bbc-news', 'gb-news', 'the-guardian', 'france24-en', 'phoenix', 'rtp3', 'welt', 'rtve', 'trt-haber', 'ntv-turkey', 'cnn-turk', 'tv-rain', 'rt', 'tvp-info', 'telewizja-republika', 'tagesschau24', 'euronews-fr', 'euronews-gr', 'skai-tv', 'ert-news', 'france24-fr', 'france-info', 'bfmtv', 'tv5monde-info', 'nrk1', 'aljazeera-balkans'] },
  { key: 'latam', labelKey: 'components.liveNews.regionLatinAmerica', channelIds: ['cnn-brasil', 'jovem-pan', 'record-news', 'band-jornalismo', 'tn-argentina', 'c5n', 'milenio', 'noticias-caracol', 'ntn24', 't13', 'dw-espanol', 'rt-espanol', 'cgtn-espanol'] },
  { key: 'asia', labelKey: 'components.liveNews.regionAsia', channelIds: ['tbs-news', 'ann-news', 'ntv-news', 'cti-news', 'cgtn', 'wion', 'ndtv', 'cna-asia', 'nhk-world', 'arirang-news', 'india-today', 'abp-news'] },
  { key: 'me', labelKey: 'components.liveNews.regionMiddleEast', channelIds: ['alarabiya', 'aljazeera', 'al-hadath', 'sky-news-arabia', 'trt-world', 'iran-intl', 'press-tv', 'cgtn-arabic', 'kan-11', 'i24-news', 'asharq-news', 'aljazeera-arabic', 'aljazeera-mubasher', 'alarabiya-business', 'al-qahera-news', 'dw-arabic', 'rt-arabic', 'rudaw'] },
  { key: 'africa', labelKey: 'components.liveNews.regionAfrica', channelIds: ['africanews', 'channels-tv', 'ktn-news', 'enca', 'sabc-news', 'arise-news'] },
  { key: 'oc', labelKey: 'components.liveNews.regionOceania', channelIds: ['abc-news-au'] },
];
export const OPTIONAL_CHANNEL_REGIONS: { key: string; labelKey: string; channelIds: string[] }[] = [
  ..._REGION_ENTRIES,
];

/** HLS manifests for channels that play natively without the YouTube iframe. */
export const DIRECT_HLS_MAP: Readonly<Record<string, string>> = {
  'sky': 'https://linear901-oo-hls0-prd-gtm.delivery.skycdp.com/17501/sde-fast-skynews/master.m3u8',
  'euronews': 'https://dash4.antik.sk/live/test_euronews/playlist.m3u8',
  'dw': 'https://dwamdstream103.akamaized.net/hls/live/2015526/dwstream103/master.m3u8',
  'france24': 'https://amg00106-france24-france24-samsunguk-qvpp8.amagi.tv/playlist/amg00106-france24-france24-samsunguk/playlist.m3u8',
  'alarabiya': 'https://live.alarabiya.net/alarabiapublish/alarabiya.smil/playlist.m3u8',
  'aljazeera': 'https://live-hls-apps-aje-fa.getaj.net/AJE/index.m3u8',
  'bloomberg': 'https://bloomberg.com/media-manifest/streams/us.m3u8',
  'cnn': 'https://turnerlive.warnermediacdn.com/hls/live/586495/cnngo/cnn_slate/VIDEO_0_3564000.m3u8',
  'abc-news': 'https://lnc-abc-news.tubi.video/index.m3u8',
  'nbc-news': 'https://dai2.xumo.com/amagi_hls_data_xumo1212A-xumo-nbcnewsnow/CDN/master.m3u8',
  'ndtv': 'https://ndtvindiaelemarchana.akamaized.net/hls/live/2003679/ndtvindia/master.m3u8',
  'i24-news': 'https://bcovlive-a.akamaihd.net/6e3dd61ac4c34d6f8fb9698b565b9f50/eu-central-1/5377161796001/playlist-all_dvr.m3u8',
  'cgtn-arabic': 'https://news.cgtn.com/resource/live/arabic/cgtn-a.m3u8',
  'cbs-news': 'https://cbsn-us.cbsnstream.cbsnews.com/out/v1/55a8648e8f134e82a470f83d562deeca/master.m3u8',
  'trt-world': 'https://tv-trtworld.medya.trt.com.tr/master.m3u8',
  'sky-news-arabia': 'https://live-stream.skynewsarabia.com/c-horizontal-channel/horizontal-stream/index.m3u8',
  'al-hadath': 'https://av.alarabiya.net/alarabiapublish/alhadath.smil/playlist.m3u8',
  'rt': 'https://rt-glb.rttv.com/dvr/rtnews/playlist.m3u8',
  'abc-news-au': 'https://abc-iview-mediapackagestreams-2.akamaized.net/out/v1/6e1cc6d25ec0480ea099a5399d73bc4b/index.m3u8',
  'bbc-news': 'https://vs-hls-push-uk.live.fastly.md.bbci.co.uk/x=4/i=urn:bbc:pips:service:bbc_news_channel_hd/iptv_hd_abr_v1.m3u8',
  'tagesschau24': 'https://tagesschau.akamaized.net/hls/live/2020115/tagesschau/tagesschau_1/master.m3u8',
  'india-today': 'https://indiatodaylive.akamaized.net/hls/live/2014320/indiatoday/indiatodaylive/playlist.m3u8',
  'rudaw': 'https://svs.itworkscdn.net/rudawlive/rudawlive.smil/playlist.m3u8',
  'kan-11': 'https://kan11.media.kan.org.il/hls/live/2024514/2024514/master.m3u8',
  'tv5monde-info': 'https://ott.tv5monde.com/Content/HLS/Live/channel(info)/index.m3u8',
  'arise-news': 'https://liveedge-arisenews.visioncdn.com/live-hls/arisenews/arisenews/arisenews_web/master.m3u8',
  'nhk-world': 'https://nhkwlive-ojp.akamaized.net/hls/live/2003459/nhkwlive-ojp-en/index_4M.m3u8',
  'cbc-news': 'https://cbcnewshd-f.akamaihd.net/i/cbcnews_1@8981/index_2500_av-p.m3u8',
  'record-news': 'https://stream.ads.ottera.tv/playlist.m3u8?network_id=2116',
  'abp-news': 'https://abplivetv.pc.cdn.bitgravity.com/httppush/abp_livetv/abp_abpnews/master.m3u8',
  'nrk1': 'https://nrk-nrk1.akamaized.net/21/0/hls/nrk_1/playlist.m3u8',
  'aljazeera-balkans': 'https://live-hls-web-ajb.getaj.net/AJB/index.m3u8',
  'sabc-news': 'https://sabconetanw.cdn.mangomolo.com/news/smil:news.stream.smil/chunklist_b250000_t64MjQwcA==.m3u8',
  'arirang-news': 'https://amdlive-ch01-ctnd-com.akamaized.net/arirang_1ch/smil:arirang_1ch.smil/playlist.m3u8',
  'fox-news': 'https://247preview.foxnews.com/hls/live/2020027/fncv3preview/primary.m3u8',
  'aljazeera-arabic': 'https://live-hls-web-aja.getaj.net/AJA/index.m3u8',
  'cgtn': 'https://news.cgtn.com/resource/live/english/cgtn-news.m3u8',
  'gb-news': 'https://live-gbnews.simplestreamcdn.com/live5/gbnews/bitrate1.isml/manifest.m3u8',
  'reuters-tv': 'https://reuters-reutersnow-1-eu.rakuten.wurl.tv/playlist.m3u8',
  'the-guardian': 'https://rakuten-guardian-1-ie.samsung.wurl.tv/playlist.m3u8',
  'phoenix': 'https://zdf-hls-19.akamaized.net/hls/live/2016502/de/veryhigh/master.m3u8',
  'ctv-news': 'https://pe-fa-lp02a.9c9media.com/live/News1Digi/p/hls/00000201/38ef78f479b07aa0/index/0c6a10a2/live/stream/h264/v1/3500000/manifest.m3u8',
  'al-qahera-news': 'https://bcovlive-a.akamaihd.net/d30cbb3350af4cb7a6e05b9eb1bfd850/eu-west-1/6057955906001/playlist.m3u8',
  'aljazeera-mubasher': 'https://live-hls-web-ajm.getaj.net/AJM/index.m3u8',
  'alarabiya-business': 'https://live.alarabiya.net/alarabiapublish/aswaaq.smil/playlist.m3u8',
  'rtp3': 'https://streaming-live.rtp.pt/livetvhlsDVR/rtpnHDdvr.smil/playlist.m3u8?DVR=',
  'dw-arabic': 'https://dwamdstream103.akamaized.net/hls/live/2015526/dwstream103/index.m3u8',
  'dw-espanol': 'https://dwamdstream104.akamaized.net/hls/live/2015530/dwstream104/stream04/streamPlaylist.m3u8',
  'rt-arabic': 'https://rt-arb.rttv.com/dvr/rtarab/playlist.m3u8',
  'rt-espanol': 'https://rt-esp.rttv.com/dvr/rtesp/playlist.m3u8',
  'cgtn-espanol': 'https://news.cgtn.com/resource/live/espanol/cgtn-e.m3u8',
  'press-tv': 'https://cdnlive.presstv.ir/cdnlive/smil:cdnlive.smil/playlist.m3u8',
};

export type WebcamRegion = 'middle-east' | 'europe' | 'asia' | 'americas' | 'space';

export interface WebcamFeed {
  id: string;
  city: string;
  country: string;
  region: WebcamRegion;
  channelHandle: string;
  fallbackVideoId: string;
}

// Verified YouTube live stream IDs — validated Feb 2026 via title cross-check.
// IDs may rotate; update when stale.
export const WEBCAM_FEEDS: WebcamFeed[] = [
  // Middle East — Jerusalem & Tehran adjacent (conflict hotspots)
  { id: 'jerusalem', city: 'Jerusalem', country: 'Israel', region: 'middle-east', channelHandle: '@TheWesternWall', fallbackVideoId: 'e34xb-Fbl0U' },
  { id: 'middle-east', city: 'Middle East', country: 'Multi', region: 'middle-east', channelHandle: '@MiddleEastCams', fallbackVideoId: 'oxT5R6I0N6E' },
  { id: 'tel-aviv', city: 'Tel Aviv', country: 'Israel', region: 'middle-east', channelHandle: '@IsraelLiveCam', fallbackVideoId: 'gmtlJ_m2r5A' },
  { id: 'mecca', city: 'Mecca', country: 'Saudi Arabia', region: 'middle-east', channelHandle: '@MakkahLive', fallbackVideoId: 'kJwEsQTegxk' },
  { id: 'beirut-mtv', city: 'Beirut', country: 'Lebanon', region: 'middle-east', channelHandle: '@MTVLebanonNews', fallbackVideoId: 'djF-Lkgfp6k' },
  // Europe
  { id: 'kyiv', city: 'Kyiv', country: 'Ukraine', region: 'europe', channelHandle: '@DWNews', fallbackVideoId: '-Q7FuPINDjA' },
  { id: 'odessa', city: 'Odessa', country: 'Ukraine', region: 'europe', channelHandle: '@UkraineLiveCam', fallbackVideoId: 'e2gC37ILQmk' },
  { id: 'paris', city: 'Paris', country: 'France', region: 'europe', channelHandle: '@PalaisIena', fallbackVideoId: 'OzYp4NRZlwQ' },
  { id: 'st-petersburg', city: 'St. Petersburg', country: 'Russia', region: 'europe', channelHandle: '@SPBLiveCam', fallbackVideoId: 'CjtIYbmVfck' },
  { id: 'london', city: 'London', country: 'UK', region: 'europe', channelHandle: '@EarthCam', fallbackVideoId: 'Lxqcg1qt0XU' },
  // Americas
  { id: 'washington', city: 'Washington DC', country: 'USA', region: 'americas', channelHandle: '@AxisCommunications', fallbackVideoId: '1wV9lLe14aU' },
  { id: 'new-york', city: 'New York', country: 'USA', region: 'americas', channelHandle: '@EarthCam', fallbackVideoId: '4qyZLflp-sI' },
  { id: 'los-angeles', city: 'Los Angeles', country: 'USA', region: 'americas', channelHandle: '@VeniceVHotel', fallbackVideoId: 'EO_1LWqsCNE' },
  { id: 'miami', city: 'Miami', country: 'USA', region: 'americas', channelHandle: '@FloridaLiveCams', fallbackVideoId: '5YCajRjvWCg' },
  // Asia-Pacific — Taipei first (strait hotspot), then Shanghai, Tokyo, Seoul
  { id: 'taipei', city: 'Taipei', country: 'Taiwan', region: 'asia', channelHandle: '@JackyWuTaipei', fallbackVideoId: 'z_fY1pj1VBw' },
  { id: 'shanghai', city: 'Shanghai', country: 'China', region: 'asia', channelHandle: '@SkylineWebcams', fallbackVideoId: '76EwqI5XZIc' },
  { id: 'tokyo', city: 'Tokyo', country: 'Japan', region: 'asia', channelHandle: '@TokyoLiveCam4K', fallbackVideoId: '_k-5U7IeK8g' },
  { id: 'seoul', city: 'Seoul', country: 'South Korea', region: 'asia', channelHandle: '@UNvillage_live', fallbackVideoId: '-JhoMGoAfFc' },
  { id: 'sydney', city: 'Sydney', country: 'Australia', region: 'asia', channelHandle: '@WebcamSydney', fallbackVideoId: '7pcL-0Wo77U' },
  // Space
  { id: 'iss-earth', city: 'ISS Earth View', country: 'Space', region: 'space', channelHandle: '@NASA', fallbackVideoId: 'vytmBNhc9ig' },
  { id: 'nasa-live', city: 'NASA TV', country: 'Space', region: 'space', channelHandle: '@NASA', fallbackVideoId: 'zPH5KtjJFaQ' },
  { id: 'space-x', city: 'SpaceX', country: 'Space', region: 'space', channelHandle: '@SpaceX', fallbackVideoId: 'fO9e9jnhYK8' },
  { id: 'space-walk', city: 'Space', country: 'Space', region: 'space', channelHandle: '@NASA', fallbackVideoId: 'fO9e9jnhYK8' },
];
