export interface PlayerProfile {
  id: string;
  name: string;
  skins: {
    id: string;
    state: string;
    url: string;
    variant?: string | null;
  }[];
  capes: {
    id: string;
    state: string;
    url: string;
    alias?: string | null;
  }[];
}
