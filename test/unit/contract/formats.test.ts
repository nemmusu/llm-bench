import { describe, expect, it } from 'vitest';
import {
  MTP_HEAD_MAX_SHARE,
  namesNinfer,
  NINFER_CONTAINER_VERSION,
  otherFormatOf,
  otherFormatsOf,
  precisionFromConfig,
  precisionFromDtypes,
  precisionFromText,
  parseNinferManifest,
  parseSha256Sums,
  refineGgufKinds,
  repoLayout,
  variantDownload,
  type RepoFile,
} from '../../../src/contract/formats';
import { BUSY_NOTE_SHARE, busyVram, VRAM_RESERVE_MIB } from '../../../src/contract/models';
import { toHubFile } from '../../../src/core/models/hub';

describe('the "other programs" note', () => {
  const card = { totalMiB: 32607, level: 'good' as const };
  it('speaks when the busy memory changes this launch, or is a notable share of the card', () => {
    // Little in use, nothing changes: nothing to say.
    expect(busyVram({ ...card, busyMiB: 2300, freeNowMiB: 30307, levelNow: 'good' })).toBeUndefined();
    // Changes the verdict of a launch now.
    expect(busyVram({ ...card, busyMiB: 2300, freeNowMiB: 30307, levelNow: 'partial' })).toEqual({ busyMiB: 2300, freeMiB: 30307 });
    // A notable share of the card beyond the reserve, whatever the model.
    const notable = Math.ceil(BUSY_NOTE_SHARE * card.totalMiB) + VRAM_RESERVE_MIB;
    expect(busyVram({ ...card, busyMiB: notable, freeNowMiB: card.totalMiB - notable, levelNow: 'good' })).toEqual({ busyMiB: notable, freeMiB: card.totalMiB - notable });
    expect(busyVram({ totalMiB: 32607, busyMiB: notable, freeNowMiB: 100 })).toEqual({ busyMiB: notable, freeMiB: 100 });
    // Unknown: nothing.
    expect(busyVram({ ...card, freeNowMiB: 1 })).toBeUndefined();
    expect(busyVram({ ...card, busyMiB: 1 })).toBeUndefined();
    expect(busyVram({ busyMiB: 1, freeNowMiB: 1 })).toBeUndefined();
  });
});

const files = (entries: [string, number][]): RepoFile[] => entries.map(([path, size]) => toHubFile({ path, size }));

/**
 * The layout of the user's real repos (names and sizes copied from the Linux library, no content):
 * nerkyor's "kitchen sink" with GGUF in a sub-folder next to safetensors variants and NInfer files.
 */
const NERKYOR = files([
  ['.gitattributes', 1_600],
  ['README.md', 22_000],
  ['assets/benchmark.png', 300_000],
  ['GGUF/Qwen3.8-27B-Coder390-EfficientThink-Q4LynnStyle-MTP.gguf', 19_620_000_000],
  ['GGUF/Qwen3.8-27B-Coder390-EfficientThink-Q4LynnStyle-Q8MTP.gguf', 19_832_743_232],
  ['GGUF/Qwen3.8-27B-Coder390-EfficientThink-Q8_0-MTP.gguf', 29_069_000_000],
  ['GGUF/mmproj-Qwen3.8-27B-Q8_0.gguf', 629_247_008],
  ['GGUF/mtp-Qwen3.8-27B-Coder390-EfficientThink-Q8_0.gguf', 3_164_006_656],
  ['BF16/config.json', 6_000],
  ['BF16/tokenizer.json', 11_000_000],
  ['BF16/tokenizer_config.json', 9_000],
  ['BF16/chat_template.jinja', 9_000],
  ['BF16/model.safetensors.index.json', 80_000],
  ['BF16/model-00001-of-00002.safetensors', 49_825_000_000],
  ['BF16/model-00002-of-00002.safetensors', 4_888_000_000],
  ['BF16/README.md', 1_000],
  ['BF16/DFlash2-FP8/config.json', 1_000],
  ['BF16/DFlash2-FP8/model.safetensors', 2_407_000_000],
  ['FP8/config.json', 6_000],
  ['FP8/model.safetensors', 28_000_000_000],
  ['INT4/W4A16/config.json', 6_000],
  ['INT4/W4A16/model.safetensors', 17_647_000_000],
  ['INT4/W4A16/model_visual.safetensors', 921_000_000],
  ['INT4/W4A16/model_mtp.safetensors', 849_000_000],
  ['INT8/W8A16/config.json', 6_000],
  ['INT8/W8A16/model-00001-of-00002.safetensors', 19_971_000_000],
  ['INT8/W8A16/model-00002-of-00002.safetensors', 9_000_000_000],
  ['INT8/W8A16/MTP-BF16/mtp-bf16.safetensors', 849_000_000],
  ['GGUF-NInfer/vision-bf16.safetensors', 921_000_000],
  ['GGUF-NInfer/model.ninfer', 18_000_000_000],
]);

/** orcarouter/OrcaSAQ-2-27B: a safetensors repo with a README, a video and pictures. */
const ORCA = files([
  ['.gitattributes', 1_625],
  ['README.md', 15_770],
  ['assets/liberty.mp4', 29_179_566],
  ['assets/pelican-bicycle.svg', 18_353],
  ['chat_template.jinja', 8_952],
  ['config.json', 6_151],
  ['generation_config.json', 202],
  ['merges.txt', 3_353_259],
  ['model-00001-of-00004.safetensors', 3_992_179_840],
  ['model-00002-of-00004.safetensors', 3_992_179_840],
  ['model-00003-of-00004.safetensors', 3_992_179_840],
  ['model-00004-of-00004.safetensors', 2_000_000_000],
  ['model.safetensors.index.json', 70_000],
  ['tokenizer.json', 11_422_654],
  ['tokenizer_config.json', 9_000],
  ['vocab.json', 2_776_833],
  ['LICENSE', 11_000],
]);

describe('precision', () => {
  it('reads it from names, folders and tags, most specific first', () => {
    expect(precisionFromText('Qwen3-8B-FP8')).toBe('FP8');
    expect(precisionFromText('INT4/W4A16')).toBe('INT4');
    expect(precisionFromText('INT8/W8A16')).toBe('INT8');
    expect(precisionFromText('Llama-3.1-8B-GPTQ-Int4')).toBe('GPTQ');
    expect(precisionFromText('Qwen3-8B-AWQ')).toBe('AWQ');
    expect(precisionFromText('Qwen3-30B-A3B-NVFP4')).toBe('NVFP4');
    expect(precisionFromText('gpt-oss-20b', 'mxfp4')).toBe('MXFP4');
    expect(precisionFromText('BF16')).toBe('BF16');
    expect(precisionFromText('model-fp16')).toBe('FP16');
    expect(precisionFromText('model-f32')).toBe('FP32');
    expect(precisionFromText('bnb-4bit')).toBe('INT4');
    // Words only: not inside other names.
    expect(precisionFromText('Hawqwen-7B')).toBeUndefined();
    expect(precisionFromText('Qwen3-8B')).toBeUndefined();
  });

  it('reads it from the hub dtype counts: the dtype holding most parameters', () => {
    expect(precisionFromDtypes({ BF16: 8e9 })).toBe('BF16');
    expect(precisionFromDtypes({ F8_E4M3: 26e9, BF16: 1e9 })).toBe('FP8');
    expect(precisionFromDtypes({ I32: 3e9, F16: 1e8 })).toBe('INT4');
    expect(precisionFromDtypes({ U8: 9e9, F8_E4M3: 1e8, BF16: 1e8 })).toBe('NVFP4');
    expect(precisionFromDtypes({ U8: 9e9, BF16: 1e8 })).toBe('MXFP4');
    expect(precisionFromDtypes({ I8: 8e9 })).toBe('INT8');
    expect(precisionFromDtypes({ F16: 8e9 })).toBe('FP16');
    expect(precisionFromDtypes({ F32: 8e9 })).toBe('FP32');
    expect(precisionFromDtypes({ BOOL: 8e9 })).toBeUndefined();
    expect(precisionFromDtypes({ BF16: 0 })).toBeUndefined();
    expect(precisionFromDtypes(undefined)).toBeUndefined();
  });

  it('reads it from a config.json: the quantization method, else the dtype', () => {
    expect(precisionFromConfig({ quantization_config: { quant_method: 'awq' } })).toBe('AWQ');
    expect(precisionFromConfig({ quantization_config: { quant_method: 'gptq' } })).toBe('GPTQ');
    expect(precisionFromConfig({ quantization_config: { quant_method: 'fp8' } })).toBe('FP8');
    expect(precisionFromConfig({ quantization_config: { quant_method: 'fbgemm_fp8' } })).toBe('FP8');
    expect(precisionFromConfig({ quantization_config: { quant_method: 'mxfp4' } })).toBe('MXFP4');
    expect(precisionFromConfig({ quantization_config: { quant_method: 'bitsandbytes', load_in_4bit: true } })).toBe('INT4');
    expect(precisionFromConfig({ quantization_config: { quant_method: 'bitsandbytes', load_in_8bit: true } })).toBe('INT8');
    expect(precisionFromConfig({ quantization_config: { quant_method: 'modelopt', quant_algo: 'NVFP4' } })).toBe('NVFP4');
    expect(precisionFromConfig({ quantization_config: { quant_method: 'compressed-tensors', format: 'nvfp4-pack-quantized' } })).toBe('NVFP4');
    const ct = (weights: object) => ({ quantization_config: { quant_method: 'compressed-tensors', config_groups: { group_0: { weights } } } });
    expect(precisionFromConfig(ct({ num_bits: 4, type: 'int' }))).toBe('INT4');
    expect(precisionFromConfig(ct({ num_bits: 8, type: 'float' }))).toBe('FP8');
    expect(precisionFromConfig(ct({ num_bits: 8, type: 'int' }))).toBe('INT8');
    expect(precisionFromConfig(ct({ num_bits: 2 }))).toBeUndefined();
    expect(precisionFromConfig({ quantization_config: { quant_method: 'unknown-thing' } })).toBeUndefined();
    expect(precisionFromConfig({ quantization_config: {} })).toBeUndefined();
    expect(precisionFromConfig({ torch_dtype: 'bfloat16' })).toBe('BF16');
    expect(precisionFromConfig({ dtype: 'float16' })).toBe('FP16');
    expect(precisionFromConfig({ torch_dtype: 'float32' })).toBe('FP32');
    expect(precisionFromConfig({})).toBeUndefined();
    expect(precisionFromConfig(null)).toBeUndefined();
    expect(precisionFromConfig([1])).toBeUndefined();
  });
});

describe('other formats', () => {
  it('by folder name or extension; a .gguf is always GGUF', () => {
    // NInfer is a format of its own (repoLayout's `ninfer`), never "other".
    expect(otherFormatOf('GGUF-NInfer/vision-bf16.safetensors')).toBeUndefined();
    expect(otherFormatOf('mlx/model.gguf')).toBeUndefined();
    expect(otherFormatOf('mlx/model.ninfer')).toBeUndefined();
    expect(otherFormatOf('mlx/model.safetensors')).toBe('MLX');
    expect(otherFormatOf('onnx/model.onnx')).toBe('ONNX');
    expect(otherFormatOf('model.onnx_data')).toBe('ONNX');
    expect(otherFormatOf('openvino/openvino_model.xml')).toBe('OpenVINO');
    expect(otherFormatOf('coreml/model.mlpackage')).toBe('Core ML');
    expect(otherFormatOf('exl2-4.0bpw/output.safetensors')).toBe('EXL2');
    expect(otherFormatOf('trt/rank0.engine')).toBe('TensorRT');
    expect(otherFormatOf('model.tflite')).toBe('TFLite');
    expect(otherFormatOf('model.pte')).toBe('ExecuTorch');
    expect(otherFormatOf('weights.npz')).toBe('MLX');
    expect(otherFormatOf('original/consolidated.pth')).toBe('PyTorch');
    expect(otherFormatOf('tf_model.h5')).toBe('Keras');
    expect(otherFormatOf('flax_model.msgpack')).toBe('Flax');
    expect(otherFormatOf('model.safetensors')).toBeUndefined();
    expect(otherFormatOf('config.json')).toBeUndefined();
  });

  it('by the tags and the name of a search result', () => {
    expect(otherFormatsOf('Qwen3-8B-4bit', ['mlx', 'safetensors'])).toEqual(['MLX']);
    expect(otherFormatsOf('Qwen3.8-27B-Coder-GGUF-NInfer', ['gguf'])).toEqual([]);
    expect(namesNinfer('Qwen3.8-27B-nvfp4-NInfer')).toBe(true);
    expect(namesNinfer('Coder-GGUF-NInfer')).toBe(true);
    expect(namesNinfer('Inferno-7B')).toBe(false);
    expect(otherFormatsOf('m-onnx', ['onnx', 'peft'])).toEqual(['LoRA', 'ONNX']);
    expect(otherFormatsOf('Qwen3-8B', ['safetensors'])).toEqual([]);
    // "original" is a folder name, never a format in a repo name.
    expect(otherFormatsOf('original', [])).toEqual([]);
  });
});

describe('repo layout', () => {
  it('splits a mixed repo: GGUF in a sub-folder, one model per safetensors folder, the rest as other formats', () => {
    const layout = repoLayout(refineGgufKinds(NERKYOR), { name: 'Qwen3.8-27B-Coder390-GGUF-NInfer' });
    // llama.cpp: three whole models (the "-MTP" ones carry fused MTP layers), the head and mmproj as extras.
    expect(layout.gguf.weights.map((f) => f.path.split('/')[1])).toEqual([
      'Qwen3.8-27B-Coder390-EfficientThink-Q4LynnStyle-MTP.gguf',
      'Qwen3.8-27B-Coder390-EfficientThink-Q4LynnStyle-Q8MTP.gguf',
      'Qwen3.8-27B-Coder390-EfficientThink-Q8_0-MTP.gguf',
    ]);
    expect(layout.gguf.extras.map((f) => f.kind).sort()).toEqual(['mmproj', 'mtp']);
    // vLLM / SGLang: one model per folder with a config.json, with its precision.
    expect(layout.safetensors.map((v) => [v.dir, v.precision])).toEqual([
      ['BF16', 'BF16'],
      ['FP8', 'FP8'],
      ['INT4/W4A16', 'INT4'],
      ['INT8/W8A16', 'INT8'],
    ]);
    const bf16 = layout.safetensors[0]!;
    // Exactly what vLLM reads: weights, index, config, tokenizer, chat template. Not the README, not the draft folder.
    expect(bf16.files.map((f) => f.path)).toEqual([
      'BF16/chat_template.jinja',
      'BF16/config.json',
      'BF16/model-00001-of-00002.safetensors',
      'BF16/model-00002-of-00002.safetensors',
      'BF16/model.safetensors.index.json',
      'BF16/tokenizer.json',
      'BF16/tokenizer_config.json',
    ]);
    expect(bf16.weights).toHaveLength(2);
    expect(bf16.sizeBytes).toBe(bf16.files.reduce((a, f) => a + f.sizeBytes, 0));
    // The visual encoder and the MTP weights of a folder go with it (its index may list them).
    expect(layout.safetensors[2]!.files.map((f) => f.path.split('/').pop())).toEqual(['config.json', 'model.safetensors', 'model_mtp.safetensors', 'model_visual.safetensors']);
    // NInfer: the artifact, a model of its own.
    expect(layout.ninfer.map((a) => [a.dir, a.artifact.path, a.files.length])).toEqual([['GGUF-NInfer', 'GGUF-NInfer/model.ninfer', 1]]);
    // Not models: loose weights without a config, the draft and MTP modules.
    expect(layout.other.map((g) => [g.format, g.dir])).toEqual([
      ['draft', 'BF16/DFlash2-FP8'],
      ['safetensors', 'GGUF-NInfer'],
      ['MTP', 'INT8/W8A16/MTP-BF16'],
    ]);
  });

  it('a safetensors repo is one model: README, licence, pictures and videos stay out', () => {
    const layout = repoLayout(ORCA, { name: 'OrcaSAQ-2-27B', tags: ['safetensors'] });
    expect(layout.gguf.weights).toEqual([]);
    expect(layout.other).toEqual([]);
    expect(layout.safetensors).toHaveLength(1);
    const root = layout.safetensors[0]!;
    expect(root.dir).toBe('');
    expect(root.precision).toBeUndefined();
    expect(root.weights).toHaveLength(4);
    const paths = root.files.map((f) => f.path);
    expect(paths).not.toContain('README.md');
    expect(paths).not.toContain('assets/liberty.mp4');
    expect(paths).not.toContain('.gitattributes');
    expect(paths).not.toContain('LICENSE');
    expect(paths).toContain('merges.txt');
    expect(paths).toContain('vocab.json');
    expect(variantDownload(ORCA)).toEqual(paths);
    expect(variantDownload(ORCA, 'nope')).toEqual([]);
    // The precision of root weights comes from the repo name and tags.
    expect(repoLayout(ORCA, { name: 'OrcaSAQ-2-27B-FP8' }).safetensors[0]?.precision).toBe('FP8');
    expect(variantDownload(ORCA, '', { name: 'x', tags: ['awq'] })).toEqual(paths);
  });

  it('GGUF and safetensors side by side in the root; originals are PyTorch', () => {
    const layout = repoLayout(
      files([
        ['config.json', 900],
        ['model.safetensors', 1_500_000_000],
        ['tokenizer.json', 1000],
        ['Qwen3-0.6B-F16.gguf', 1_200_000_000],
        ['original/consolidated.pth', 1_500_000_000],
      ]),
    );
    expect(layout.gguf.weights.map((f) => f.path)).toEqual(['Qwen3-0.6B-F16.gguf']);
    expect(layout.safetensors.map((v) => v.files.map((f) => f.path))).toEqual([['config.json', 'model.safetensors', 'tokenizer.json']]);
    expect(layout.other.map((g) => g.format)).toEqual(['PyTorch']);
  });

  it('PyTorch .bin weights only when there are no safetensors; MLX, LoRA and loose weights are other formats', () => {
    const bin = repoLayout(files([['config.json', 1], ['pytorch_model.bin', 9], ['pytorch_model.bin.index.json', 1]]));
    expect(bin.safetensors[0]?.files.map((f) => f.path)).toEqual(['config.json', 'pytorch_model.bin', 'pytorch_model.bin.index.json']);
    const both = repoLayout(files([['config.json', 1], ['model.safetensors', 9], ['pytorch_model.bin', 9]]));
    expect(both.safetensors[0]?.weights.map((f) => f.path)).toEqual(['model.safetensors']);
    expect(repoLayout(files([['config.json', 1], ['model.safetensors', 9]]), { tags: ['MLX'] }).other.map((g) => g.format)).toEqual(['MLX']);
    expect(repoLayout(files([['adapter_config.json', 1], ['adapter_model.safetensors', 9]])).other.map((g) => g.format)).toEqual(['LoRA']);
    expect(repoLayout(files([['vision/encoder.safetensors', 9]])).other.map((g) => [g.format, g.dir])).toEqual([['safetensors', 'vision']]);
    // Mistral's own layout: params.json instead of config.json.
    expect(repoLayout(files([['params.json', 1], ['consolidated.safetensors', 9], ['tekken.json', 1]])).safetensors[0]?.files.map((f) => f.path)).toEqual([
      'consolidated.safetensors',
      'params.json',
      'tekken.json',
    ]);
    // Nothing loadable: no folders at all.
    expect(repoLayout([]).safetensors).toEqual([]);
  });

  it('an NInfer repo: each .ninfer artifact with the manifest and checksums of its folder, largest first', () => {
    const layout = repoLayout(
      files([
        ['README.md', 4000],
        ['Qwen3.8-27B-nvfp4-NInfer.artifact-manifest.json', 900],
        ['Qwen3.8-27B-nvfp4-NInfer.SHA256SUMS', 200],
        ['qwen3_8_27b_nvfp4.ninfer', 23_700_000_000],
        ['small/qwen3_8_4b_nvfp4.ninfer', 3_000_000_000],
      ]),
    );
    expect(layout.ninfer.map((a) => [a.dir, a.files.map((f) => f.path)])).toEqual([
      ['', ['Qwen3.8-27B-nvfp4-NInfer.SHA256SUMS', 'Qwen3.8-27B-nvfp4-NInfer.artifact-manifest.json', 'qwen3_8_27b_nvfp4.ninfer']],
      ['small', ['small/qwen3_8_4b_nvfp4.ninfer']],
    ]);
    expect(layout.ninfer[0]?.sizeBytes).toBe(23_700_001_100);
    expect(layout.other).toEqual([]);
    expect(layout.safetensors).toEqual([]);
  });

  it('reads NInfer manifests leniently and SHA256SUMS lines', () => {
    expect(
      parseNinferManifest({
        artifact: { filename: 'q.ninfer', bytes: 10, sha256: 'AB'.repeat(32), container_version: NINFER_CONTAINER_VERSION, architecture: 'qwen3_8', name: 'Qwen3.8 27B', components: ['text', 'vision', 3] },
      }),
    ).toEqual({ filename: 'q.ninfer', bytes: 10, sha256: 'ab'.repeat(32), containerVersion: 3, architecture: 'qwen3_8', name: 'Qwen3.8 27B', components: ['text', 'vision'] });
    expect(parseNinferManifest({ artifact: { bytes: 'x', name: '' } })).toEqual({ components: [] });
    expect(parseNinferManifest({})).toBeUndefined();
    expect(parseNinferManifest(null)).toBeUndefined();
    const sums = parseSha256Sums(`${'a'.repeat(64)}  q.ninfer\r\n${'B'.repeat(64)} *./manifest.json\nnot a line\n`);
    expect(parseSha256Sums(undefined).size).toBe(0);
    expect([...sums]).toEqual([
      ['q.ninfer', 'a'.repeat(64)],
      ['manifest.json', 'b'.repeat(64)],
    ]);
  });

  it('an MTP-named GGUF much smaller than the biggest one is the head, a big one is a whole model', () => {
    const refined = refineGgufKinds(
      files([
        ['Model-27B-MTP-Q4_K_M.gguf', 17e9],
        ['Model-27B-MTP-Q8_0.gguf', 29e9],
        ['Model-MTP-Q8_0-small.gguf', 29e9 * MTP_HEAD_MAX_SHARE - 1],
        ['config.json', 1],
      ]),
    );
    expect(refined.map((f) => f.kind)).toEqual(['weights', 'weights', 'mtp', 'config']);
  });
});
