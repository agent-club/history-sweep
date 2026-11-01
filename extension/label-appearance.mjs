export const LABEL_COLOR_PRESETS = {
  sage: { foreground: '#315b49', background: '#e5f0e8' },
  sky: { foreground: '#315c82', background: '#e6eff8' },
  lavender: { foreground: '#655081', background: '#efe9f6' },
  sand: { foreground: '#775a32', background: '#f5eddd' },
  rose: { foreground: '#854e5d', background: '#f7e9ee' },
  slate: { foreground: '#4b5767', background: '#eaf0f4' },
};

// Small inline textures work offline in both extension pages and the modal iframe.
const texture = content => `url("data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="160" height="64" viewBox="0 0 160 64">${content}</svg>`)}")`;
export const LABEL_BACKGROUNDS = {
  linen: texture('<path d="M0 8H160M0 24H160M0 40H160M0 56H160M8 0V64M24 0V64M40 0V64M56 0V64M72 0V64M88 0V64M104 0V64M120 0V64M136 0V64M152 0V64" stroke="#fff" stroke-opacity=".45"/>'),
  waves: texture('<path d="M-20 20Q20-4 60 20T140 20T220 20M-20 36Q20 12 60 36T140 36T220 36M-20 52Q20 28 60 52T140 52T220 52" fill="none" stroke="#fff" stroke-width="5" stroke-opacity=".5"/>'),
  hills: texture('<path d="M0 64V38L45 8L90 64M52 64L112 12L160 42V64" fill="#fff" fill-opacity=".4"/>'),
};

export const LABEL_IMAGE_MAX_LENGTH = 80000;

export function validateLabelAppearance(value) {
  const fail = () => { throw new Error('INVALID_WORKSPACE_SETTINGS'); };
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.keys(value).some(key => !['foreground', 'background', 'image'].includes(key)) ||
      typeof value.foreground !== 'string' || typeof value.background !== 'string' ||
      !/^#[\da-f]{6}$/i.test(value.foreground) || !/^#[\da-f]{6}$/i.test(value.background)) return fail();
  const appearance = { foreground: value.foreground.toLowerCase(), background: value.background.toLowerCase() };
  if (value.image !== undefined) {
    if (typeof value.image !== 'string' || (!Object.hasOwn(LABEL_BACKGROUNDS, value.image) &&
        !(value.image.length <= LABEL_IMAGE_MAX_LENGTH && /^data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/]+={0,2}$/.test(value.image)))) return fail();
    appearance.image = value.image;
  }
  return appearance;
}
