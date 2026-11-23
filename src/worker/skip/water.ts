// The bundled water index (Natural Earth, see scripts/build-water.ts). The data
// module is a ~1.2 MB string, so it is imported lazily: requests that never plan
// a scan do not pay for parsing it, and the index is built once per isolate.
import { createWaterIndex, decodeBase64, type WaterIndex } from "@/shared/skip/water";

let loaded: Promise<WaterIndex> | null = null;

export function loadWaterIndex(): Promise<WaterIndex> {
  loaded ??= import("./water-data").then((m) => createWaterIndex(decodeBase64(m.WATER_DATA_B64)));
  return loaded;
}
