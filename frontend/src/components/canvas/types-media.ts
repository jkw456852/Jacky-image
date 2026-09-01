/** 画布参考图类型（原 @/types/image 精简版，已去除 video/audio）。 */
export type ReferenceImage = {
  id: string;
  name: string;
  type: string;
  dataUrl: string;
  url?: string;
  storageKey?: string;
};
