/** Reading-room palette: low ambient light, high legibility, colour reserved for state. */
export const colors = {
  ink: '#0B1620', // app background, deep slate rather than black
  panel: '#12222D',
  raised: '#1A303E',
  line: '#24404F',
  text: '#DCE6EC',
  muted: '#8099A8',
  accent: '#5EC2B7', // active tool, primary action
  overlay: '#F0D98C', // on-image annotation text, the traditional amber
  danger: '#E8846E',
  viewport: '#000000', // image area stays true black for contrast
};

export const type = {
  small: 12,
  body: 15,
  title: 17,
  heading: 24,
};

export const space = (n: number) => n * 4;

export const modalityTint: Record<string, string> = {
  CT: '#6FA8DC',
  MR: '#B48EDB',
  CR: '#9CC48A',
  DX: '#9CC48A',
  US: '#E3B36B',
  MG: '#E39BB6',
  NM: '#E8846E',
  PT: '#E8846E',
  XA: '#7FC6D6',
};
