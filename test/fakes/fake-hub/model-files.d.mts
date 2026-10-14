export interface GgufTypedValue {
  type: number;
  value: unknown;
  sub?: number;
}
export type GgufValue = string | number | bigint | boolean | (string | number | boolean)[] | GgufTypedValue;

export interface GgufTensorSpec {
  name: string;
  shape: number[];
  /** GGML type id (0 F32, 1 F16, 8 Q8_0, 12 Q4_K, 14 Q6_K…). */
  type?: number;
}

export interface GgufSpec {
  metadata?: Record<string, GgufValue>;
  tensors?: GgufTensorSpec[];
  version?: 1 | 2 | 3;
  alignment?: number;
  totalSize?: number;
  seed?: number;
}

export interface SafetensorsSpec {
  tensors?: Record<string, { dtype: string; shape: number[] }>;
  metadata?: Record<string, string>;
  totalSize?: number;
  seed?: number;
}

export interface LlamaLikeOptions {
  arch?: string;
  name?: string;
  sizeLabel?: string;
  fileType?: number;
  layers?: number;
  heads?: number;
  kvHeads?: number | number[];
  headDim?: number;
  embd?: number;
  ctx?: number;
  vocab?: number;
  extra?: Record<string, GgufValue>;
  tied?: boolean;
}

export declare const GGUF_TYPE: Readonly<Record<'UINT8' | 'INT8' | 'UINT16' | 'INT16' | 'UINT32' | 'INT32' | 'FLOAT32' | 'BOOL' | 'STRING' | 'ARRAY' | 'UINT64' | 'INT64' | 'FLOAT64', number>>;
export declare const gv: {
  u8(v: number): GgufTypedValue;
  i8(v: number): GgufTypedValue;
  u16(v: number): GgufTypedValue;
  i16(v: number): GgufTypedValue;
  u32(v: number): GgufTypedValue;
  i32(v: number): GgufTypedValue;
  f32(v: number): GgufTypedValue;
  bool(v: boolean): GgufTypedValue;
  str(v: string): GgufTypedValue;
  u64(v: number | bigint): GgufTypedValue;
  i64(v: number | bigint): GgufTypedValue;
  f64(v: number): GgufTypedValue;
  arr(sub: number, values: unknown[]): GgufTypedValue;
};
export declare function tensorDataBytes(shape: number[], type: number): number;
export declare function seededBytes(seed: number, length: number): Uint8Array;
export declare function buildGguf(spec?: GgufSpec): Uint8Array;
export declare function buildSafetensors(spec?: SafetensorsSpec): Uint8Array;

export interface NinferSpec {
  name?: string;
  components?: string[];
  layouts?: string[];
  version?: number;
  totalSize?: number;
  seed?: number;
}
export declare function buildNinfer(spec?: NinferSpec): Uint8Array;
export declare function llamaLikeGguf(opts?: LlamaLikeOptions): { metadata: Record<string, GgufValue>; tensors: GgufTensorSpec[] };
