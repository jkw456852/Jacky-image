import JSZip from "jszip";

type ZipFile = {
  name: string;
  data: BlobPart;
};

/** 用本项目已有的 jszip 重写（原实现依赖 fflate）。 */
export async function createZip(files: ZipFile[]) {
  const zip = new JSZip();
  for (const file of files) {
    zip.file(file.name, new Blob([file.data]));
  }
  return zip.generateAsync({ type: "blob" });
}

export async function readZip(file: Blob) {
  const zip = await JSZip.loadAsync(file);
  const map = new Map<string, Blob>();
  await Promise.all(
    Object.keys(zip.files).map(async (name) => {
      const entry = zip.files[name];
      if (entry.dir) return;
      map.set(name, await entry.async("blob"));
    }),
  );
  return map;
}
