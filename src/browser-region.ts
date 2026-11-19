type RegionPreset = {
  locales: readonly string[];
  timezones: readonly string[];
};

// Representative time zones from IANA tzdb zone.tab and common browser
// languages for each territory, cross-checked against Unicode CLDR.
const presets: Record<string, RegionPreset> = {
  AU: {
    locales: ["en-AU"],
    timezones: [
      "Australia/Sydney",
      "Australia/Melbourne",
      "Australia/Brisbane",
      "Australia/Perth",
      "Australia/Adelaide",
      "Australia/Darwin",
      "Australia/Hobart",
    ],
  },
  AR: {
    locales: ["es-AR"],
    timezones: [
      "America/Argentina/Buenos_Aires",
      "America/Argentina/Mendoza",
      "America/Argentina/Cordoba",
    ],
  },
  AT: { locales: ["de-AT"], timezones: ["Europe/Vienna"] },
  BE: { locales: ["nl-BE", "fr-BE", "de-BE"], timezones: ["Europe/Brussels"] },
  BD: { locales: ["bn-BD", "en-BD"], timezones: ["Asia/Dhaka"] },
  BR: {
    locales: ["pt-BR"],
    timezones: [
      "America/Sao_Paulo",
      "America/Manaus",
      "America/Fortaleza",
      "America/Belem",
      "America/Rio_Branco",
    ],
  },
  CA: {
    locales: ["en-CA", "fr-CA"],
    timezones: [
      "America/Vancouver",
      "America/Edmonton",
      "America/Winnipeg",
      "America/Toronto",
      "America/Halifax",
      "America/St_Johns",
    ],
  },
  CH: {
    locales: ["de-CH", "fr-CH", "it-CH", "rm-CH"],
    timezones: ["Europe/Zurich"],
  },
  CL: {
    locales: ["es-CL"],
    timezones: ["America/Santiago", "America/Punta_Arenas", "Pacific/Easter"],
  },
  CN: {
    locales: ["zh-CN", "zh-Hans-CN"],
    timezones: ["Asia/Shanghai", "Asia/Urumqi"],
  },
  CO: { locales: ["es-CO"], timezones: ["America/Bogota"] },
  CZ: { locales: ["cs-CZ"], timezones: ["Europe/Prague"] },
  DE: { locales: ["de-DE"], timezones: ["Europe/Berlin"] },
  DK: { locales: ["da-DK"], timezones: ["Europe/Copenhagen"] },
  EG: { locales: ["ar-EG"], timezones: ["Africa/Cairo"] },
  ES: {
    locales: ["es-ES", "ca-ES", "eu-ES", "gl-ES"],
    timezones: ["Europe/Madrid", "Africa/Ceuta", "Atlantic/Canary"],
  },
  FI: { locales: ["fi-FI", "sv-FI"], timezones: ["Europe/Helsinki"] },
  FR: { locales: ["fr-FR"], timezones: ["Europe/Paris"] },
  GB: { locales: ["en-GB", "cy-GB"], timezones: ["Europe/London"] },
  GR: { locales: ["el-GR"], timezones: ["Europe/Athens"] },
  HK: {
    locales: ["zh-HK", "zh-Hant-HK", "en-HK"],
    timezones: ["Asia/Hong_Kong"],
  },
  HU: { locales: ["hu-HU"], timezones: ["Europe/Budapest"] },
  ID: {
    locales: ["id-ID"],
    timezones: [
      "Asia/Jakarta",
      "Asia/Pontianak",
      "Asia/Makassar",
      "Asia/Jayapura",
    ],
  },
  IE: { locales: ["en-IE", "ga-IE"], timezones: ["Europe/Dublin"] },
  IL: { locales: ["he-IL", "ar-IL"], timezones: ["Asia/Jerusalem"] },
  IN: {
    locales: [
      "hi-IN",
      "en-IN",
      "bn-IN",
      "ta-IN",
      "te-IN",
      "mr-IN",
      "gu-IN",
      "kn-IN",
    ],
    timezones: ["Asia/Kolkata"],
  },
  IS: { locales: ["is-IS"], timezones: ["Atlantic/Reykjavik"] },
  IT: { locales: ["it-IT"], timezones: ["Europe/Rome"] },
  JP: { locales: ["ja-JP"], timezones: ["Asia/Tokyo"] },
  KE: { locales: ["sw-KE", "en-KE"], timezones: ["Africa/Nairobi"] },
  KR: { locales: ["ko-KR"], timezones: ["Asia/Seoul"] },
  LK: { locales: ["si-LK", "ta-LK", "en-LK"], timezones: ["Asia/Colombo"] },
  MA: { locales: ["ar-MA", "fr-MA"], timezones: ["Africa/Casablanca"] },
  MX: {
    locales: ["es-MX"],
    timezones: [
      "America/Mexico_City",
      "America/Cancun",
      "America/Tijuana",
      "America/Hermosillo",
      "America/Mazatlan",
    ],
  },
  MO: { locales: ["zh-MO", "zh-Hant-MO", "pt-MO"], timezones: ["Asia/Macau"] },
  MY: {
    locales: ["ms-MY", "en-MY", "zh-MY", "ta-MY"],
    timezones: ["Asia/Kuala_Lumpur", "Asia/Kuching"],
  },
  NG: {
    locales: ["en-NG", "ha-NG", "yo-NG", "ig-NG"],
    timezones: ["Africa/Lagos"],
  },
  NL: { locales: ["nl-NL", "fy-NL"], timezones: ["Europe/Amsterdam"] },
  NO: { locales: ["nb-NO", "nn-NO"], timezones: ["Europe/Oslo"] },
  NZ: {
    locales: ["en-NZ", "mi-NZ"],
    timezones: ["Pacific/Auckland", "Pacific/Chatham"],
  },
  PE: { locales: ["es-PE", "qu-PE"], timezones: ["America/Lima"] },
  PH: { locales: ["fil-PH", "en-PH"], timezones: ["Asia/Manila"] },
  PK: {
    locales: ["ur-PK", "en-PK", "pa-Arab-PK"],
    timezones: ["Asia/Karachi"],
  },
  PL: { locales: ["pl-PL"], timezones: ["Europe/Warsaw"] },
  PT: {
    locales: ["pt-PT"],
    timezones: ["Europe/Lisbon", "Atlantic/Madeira", "Atlantic/Azores"],
  },
  RO: { locales: ["ro-RO", "hu-RO"], timezones: ["Europe/Bucharest"] },
  RU: {
    locales: ["ru-RU"],
    timezones: [
      "Europe/Moscow",
      "Europe/Kaliningrad",
      "Asia/Yekaterinburg",
      "Asia/Novosibirsk",
      "Asia/Vladivostok",
    ],
  },
  SA: { locales: ["ar-SA"], timezones: ["Asia/Riyadh"] },
  SE: { locales: ["sv-SE"], timezones: ["Europe/Stockholm"] },
  SG: {
    locales: ["en-SG", "zh-SG", "ms-SG", "ta-SG"],
    timezones: ["Asia/Singapore"],
  },
  TH: { locales: ["th-TH"], timezones: ["Asia/Bangkok"] },
  TR: { locales: ["tr-TR"], timezones: ["Europe/Istanbul"] },
  TW: { locales: ["zh-TW", "zh-Hant-TW"], timezones: ["Asia/Taipei"] },
  UA: { locales: ["uk-UA"], timezones: ["Europe/Kyiv"] },
  US: {
    locales: ["en-US", "es-US"],
    timezones: [
      "America/New_York",
      "America/Chicago",
      "America/Denver",
      "America/Los_Angeles",
      "America/Phoenix",
      "America/Anchorage",
      "Pacific/Honolulu",
    ],
  },
  AE: { locales: ["ar-AE", "en-AE"], timezones: ["Asia/Dubai"] },
  VN: { locales: ["vi-VN"], timezones: ["Asia/Ho_Chi_Minh"] },
  ZA: {
    locales: ["en-ZA", "af-ZA", "zu-ZA", "xh-ZA"],
    timezones: ["Africa/Johannesburg"],
  },
};

const displayLanguage = new Intl.DisplayNames("zh-CN", { type: "language" });
const displayRegion = new Intl.DisplayNames("zh-CN", { type: "region" });

export const browserRegions = Object.keys(presets)
  .map((code) => ({ code, label: displayRegion.of(code) ?? code }))
  .sort((a, b) => a.label.localeCompare(b.label, "zh-CN"));

const supportedZones =
  typeof Intl.supportedValuesOf === "function"
    ? Intl.supportedValuesOf("timeZone")
    : [];
const available = Object.values(presets);

export const browserLanguages = [
  ...new Set(available.flatMap((preset) => preset.locales)),
]
  .sort()
  .map((value) => ({
    value,
    label: `${value} · ${displayLanguage.of(value) ?? value}`,
  }));

export const browserTimezones = [
  ...new Set([
    "UTC",
    ...supportedZones,
    ...available.flatMap((preset) => preset.timezones),
  ]),
].sort((a, b) => (a === "UTC" ? -1 : b === "UTC" ? 1 : a.localeCompare(b)));

type RegionValues = { locale: string; timezone: string };

export function randomBrowserRegion(
  code: string,
  current: RegionValues,
): RegionValues {
  const pool =
    code && Object.hasOwn(presets, code) ? [presets[code]] : available;
  const pairs = pool.flatMap(({ locales, timezones }) =>
    locales.flatMap((locale) =>
      timezones.map((timezone) => ({ locale, timezone })),
    ),
  );
  const different = pairs.filter(
    ({ locale, timezone }) =>
      locale !== current.locale || timezone !== current.timezone,
  );
  const choices = different.length ? different : pairs;
  return choices[Math.floor(Math.random() * choices.length)];
}
