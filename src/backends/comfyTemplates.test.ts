import { describe, expect, it } from 'vitest';

import {
  buildSimpleWorkflow,
  comfySimpleParams,
  normalizeSimpleConfig,
  simpleDefaults,
  templateSupportsNegative,
  validateSimpleConfig,
  type ComfySimpleConfig,
  type SimpleWorkflowNode,
} from '@/backends/comfyTemplates';

const VALUES = { prompt: '1girl, silver hair', seed: 42, width: 832, height: 1216 };

function config(patch: Partial<ComfySimpleConfig>): ComfySimpleConfig {
  return { ...simpleDefaults(), ...patch };
}

function node(workflow: Record<string, SimpleWorkflowNode>, id: string): SimpleWorkflowNode {
  const found = workflow[id];
  if (!found) throw new Error(`node ${id} missing`);
  return found;
}

describe('validateSimpleConfig', () => {
  it('未选模型时报错', () => {
    expect(validateSimpleConfig(simpleDefaults())).toContain('模型');
  });

  it('flux/anima 缺 VAE 或 CLIP 时报对应字段;checkpoint 外置 VAE 可留空', () => {
    const flux = { ...simpleDefaults('flux'), model: 'flux1-dev.safetensors' };
    expect(validateSimpleConfig(flux)).toContain('VAE');
    expect(validateSimpleConfig({ ...flux, vae: 'ae.safetensors' })).toContain('T5-XXL');
    expect(validateSimpleConfig({ ...flux, vae: 'ae.safetensors', clip1: 't5xxl_fp8.safetensors' })).toContain('CLIP-L');
    expect(
      validateSimpleConfig({ ...flux, vae: 'ae.safetensors', clip1: 't5xxl_fp8.safetensors', clip2: 'clip_l.safetensors' }),
    ).toBeNull();

    const anima = { ...simpleDefaults('anima'), model: 'anima.safetensors', vae: 'qwen_image_vae.safetensors' };
    expect(validateSimpleConfig(anima)).toContain('Qwen');
    expect(validateSimpleConfig({ ...anima, clip1: 'qwen_2.5_vl_7b.safetensors' })).toBeNull();

    expect(validateSimpleConfig(config({ model: 'illustrious.safetensors' }))).toBeNull();
  });
});

describe('buildSimpleWorkflow - checkpoint', () => {
  const simple = config({ model: 'illustrious_xl.safetensors', positive: 'masterpiece, best quality', negative: 'worst quality' });

  it('组出经典五节点链路,正负面按「固定+生成」拼接', () => {
    const wf = buildSimpleWorkflow(simple, { ...VALUES, negative: 'extra people' });
    expect(node(wf, '1').class_type).toBe('CheckpointLoaderSimple');
    expect(node(wf, '1').inputs.ckpt_name).toBe('illustrious_xl.safetensors');
    expect(node(wf, '3').inputs.text).toBe('masterpiece, best quality, 1girl, silver hair');
    expect(node(wf, '4').inputs.text).toBe('worst quality, extra people');
    expect(node(wf, '5').inputs).toMatchObject({ width: 832, height: 1216 });
    expect(node(wf, '6').inputs).toMatchObject({
      seed: 42,
      steps: 28,
      cfg: 5,
      sampler_name: 'euler_ancestral',
      scheduler: 'normal',
      model: ['1', 0],
      positive: ['3', 0],
      negative: ['4', 0],
    });
    // 无外置 VAE → 用 checkpoint 内置(槽位 2)
    expect(node(wf, '7').inputs.vae).toEqual(['1', 2]);
    expect(node(wf, '8').class_type).toBe('SaveImage');
  });

  it('nl 存在时优先于 tag 作为正向生成内容', () => {
    const wf = buildSimpleWorkflow(simple, { ...VALUES, nl: 'A girl with silver hair.' });
    expect(node(wf, '3').inputs.text).toBe('masterpiece, best quality, A girl with silver hair.');
  });

  it('固定词留空时只剩生成内容(不多逗号)', () => {
    const wf = buildSimpleWorkflow(config({ model: 'm.safetensors' }), VALUES);
    expect(node(wf, '3').inputs.text).toBe('1girl, silver hair');
    expect(node(wf, '4').inputs.text).toBe('');
  });

  it('外置 VAE 走 VAELoader;LoRA 串联在底模与编码之间', () => {
    const wf = buildSimpleWorkflow(
      config({
        model: 'm.safetensors',
        vae: 'fix_vae.safetensors',
        loras: [
          { name: 'style.safetensors', strength: 0.8 },
          { name: '', strength: 1 }, // 未填完的行被忽略
          { name: 'detail.safetensors', strength: 0.5 },
        ],
      }),
      VALUES,
    );
    expect(node(wf, '2').class_type).toBe('VAELoader');
    expect(node(wf, '7').inputs.vae).toEqual(['2', 0]);
    expect(node(wf, '300').inputs).toMatchObject({ lora_name: 'style.safetensors', strength_model: 0.8, model: ['1', 0], clip: ['1', 1] });
    expect(node(wf, '301').inputs).toMatchObject({ lora_name: 'detail.safetensors', model: ['300', 0], clip: ['300', 1] });
    expect(node(wf, '6').inputs.model).toEqual(['301', 0]);
    expect(node(wf, '3').inputs.clip).toEqual(['301', 1]);
    expect(wf['302']).toBeUndefined();
  });

  it('分格版式 JSON 输入时自动生成 Checkpoint/Illustrious 区域分格工作流 (ConditioningSetMask + MaskComposite)', () => {
    const layoutPrompt = JSON.stringify({
      summary: {
        caption: 'Page frame guide: panel 1; panel 2. A rainy evening inside an apartment.',
        canvas: 'multi_panel',
      },
      items: [
        {
          label: 'character',
          caption: 'Content of panel 1: 1girl, standing by window, looking at viewer',
          bbox: [-608, -416, 0, 416],
        },
        {
          label: 'character',
          caption: 'Content of panel 2: 1boy, lying on bed, resting',
          bbox: [0, -416, 608, 416],
        },
      ],
      bbox_coord_space: 'abs_centralized',
      bbox_format: 'yxyx',
    });

    const wf = buildSimpleWorkflow(simple, {
      ...VALUES,
      prompt: layoutPrompt,
      width: 832,
      height: 1216,
    });

    // 基础加载与底模链路正常
    expect(node(wf, '1').class_type).toBe('CheckpointLoaderSimple');
    expect(node(wf, '3').class_type).toBe('CLIPTextEncode');
    expect(node(wf, '3').inputs.text).toContain('2-panel manga page layout');
    expect(node(wf, '3').inputs.text).toContain('A rainy evening inside an apartment.');

    // 负面与潜空间
    expect(node(wf, '4').class_type).toBe('CLIPTextEncode');
    expect(node(wf, '4').inputs.text).toContain('illegible text, gibberish lettering');
    expect(node(wf, '5').class_type).toBe('EmptyLatentImage');
    expect(node(wf, '5').inputs).toMatchObject({ width: 832, height: 1216 });

    // Panel 1 (上格) 区域节点
    expect(node(wf, '1001').class_type).toBe('SolidMask');
    expect(node(wf, '1001').inputs).toMatchObject({ value: 0, width: 832, height: 1216 });
    expect(node(wf, '1002').class_type).toBe('SolidMask');
    expect(node(wf, '1002').inputs).toMatchObject({ value: 1, width: 832, height: 608 });
    expect(node(wf, '1003').class_type).toBe('MaskComposite');
    expect(node(wf, '1003').inputs).toMatchObject({
      destination: ['1001', 0],
      source: ['1002', 0],
      x: 0,
      y: 0,
      operation: 'add',
    });
    expect(node(wf, '1004').class_type).toBe('CLIPTextEncode');
    expect(node(wf, '1004').inputs.text).toBe('1girl, standing by window, looking at viewer');
    expect(node(wf, '1005').class_type).toBe('ConditioningSetMask');
    expect(node(wf, '1005').inputs).toMatchObject({
      conditioning: ['1004', 0],
      mask: ['1003', 0],
      strength: 1.0,
      set_cond_area: 'mask bounds',
    });
    expect(node(wf, '1006').class_type).toBe('ConditioningCombine');
    expect(node(wf, '1006').inputs).toMatchObject({
      conditioning_1: ['3', 0],
      conditioning_2: ['1005', 0],
    });

    // Panel 2 (下格) 区域节点
    expect(node(wf, '1011').class_type).toBe('SolidMask');
    expect(node(wf, '1012').class_type).toBe('SolidMask');
    expect(node(wf, '1012').inputs).toMatchObject({ value: 1, width: 832, height: 608 });
    expect(node(wf, '1013').class_type).toBe('MaskComposite');
    expect(node(wf, '1013').inputs).toMatchObject({
      destination: ['1011', 0],
      source: ['1012', 0],
      x: 0,
      y: 608,
      operation: 'add',
    });
    expect(node(wf, '1014').class_type).toBe('CLIPTextEncode');
    expect(node(wf, '1014').inputs.text).toBe('1boy, lying on bed, resting');
    expect(node(wf, '1015').class_type).toBe('ConditioningSetMask');
    expect(node(wf, '1016').class_type).toBe('ConditioningCombine');
    expect(node(wf, '1016').inputs).toMatchObject({
      conditioning_1: ['1006', 0],
      conditioning_2: ['1015', 0],
    });

    // KSampler 正向汇聚于最后一路 combine (1016)
    expect(node(wf, '6').class_type).toBe('KSampler');
    expect(node(wf, '6').inputs.positive).toEqual(['1016', 0]);
    expect(node(wf, '6').inputs.negative).toEqual(['4', 0]);
    expect(node(wf, '6').inputs.latent_image).toEqual(['5', 0]);

    // 解码与存图
    expect(node(wf, '7').class_type).toBe('VAEDecode');
    expect(node(wf, '8').class_type).toBe('SaveImage');
  });

  it('包含文字槽位(text item)时自动引导生成空白对话气泡且全局增加 empty speech bubbles 提示', () => {
    const layoutPromptWithText = JSON.stringify({
      summary: {
        caption: 'Page frame guide: panel 1. Visible lettering follows supplied text.',
        canvas: 'single',
      },
      items: [
        {
          label: 'character',
          caption: 'Content of panel 1: 1girl sitting by cafe window',
          bbox: [-400, -300, 400, 300],
        },
        {
          label: 'text',
          text: '今天天气真好呢。',
          caption: 'Black printed Chinese lettering.',
          bbox: [-500, 100, -350, 300],
        },
      ],
      bbox_coord_space: 'abs_centralized',
      bbox_format: 'yxyx',
    });

    const wf = buildSimpleWorkflow(simple, {
      ...VALUES,
      prompt: layoutPromptWithText,
      width: 832,
      height: 1216,
    });

    // 全局正向提示词包含 empty speech bubbles
    expect(node(wf, '3').inputs.text).toContain('empty speech bubbles, comic dialogue balloons');
    // text 对应区域的 prompt 自动转为空白对话气泡提示
    const textRegionNode = node(wf, '1014');
    expect(textRegionNode.class_type).toBe('CLIPTextEncode');
    expect(textRegionNode.inputs.text).toContain('empty speech bubble, blank comic dialogue balloon');
  });
});

describe('buildSimpleWorkflow - flux', () => {
  const simple: ComfySimpleConfig = {
    ...simpleDefaults('flux'),
    model: 'flux1-dev.safetensors',
    vae: 'ae.safetensors',
    clip1: 't5xxl_fp8.safetensors',
    clip2: 'clip_l.safetensors',
  };

  it('UNet + DualCLIP + ae,负面恒空、cfg 恒 1、走 FluxGuidance', () => {
    const wf = buildSimpleWorkflow(simple, { ...VALUES, negative: 'ignored' });
    expect(node(wf, '1').class_type).toBe('UNETLoader');
    expect(node(wf, '2').inputs).toMatchObject({ clip_name1: 't5xxl_fp8.safetensors', clip_name2: 'clip_l.safetensors', type: 'flux' });
    expect(node(wf, '5').inputs.text).toBe('');
    expect(node(wf, '6').inputs).toMatchObject({ guidance: 3.5, conditioning: ['4', 0] });
    expect(node(wf, '8').inputs).toMatchObject({ cfg: 1, positive: ['6', 0], negative: ['5', 0] });
    expect(node(wf, '7').class_type).toBe('EmptySD3LatentImage');
  });

  it('guidance = 1 时跳过 FluxGuidance,直连编码输出', () => {
    const wf = buildSimpleWorkflow({ ...simple, guidance: 1 }, VALUES);
    expect(wf['6']).toBeUndefined();
    expect(node(wf, '8').inputs.positive).toEqual(['4', 0]);
  });

  it('GGUF 用 UnetLoaderGGUF;LoRA 只挂 model(LoraLoaderModelOnly)', () => {
    const wf = buildSimpleWorkflow(
      { ...simple, gguf: true, loras: [{ name: 'flux_lora.safetensors', strength: 1 }] },
      VALUES,
    );
    expect(node(wf, '1').class_type).toBe('UnetLoaderGGUF');
    expect(node(wf, '300').class_type).toBe('LoraLoaderModelOnly');
    expect(node(wf, '300').inputs).not.toHaveProperty('clip');
    expect(node(wf, '8').inputs.model).toEqual(['300', 0]);
  });
});

describe('buildSimpleWorkflow - anima', () => {
  const simple: ComfySimpleConfig = {
    ...simpleDefaults('anima'),
    model: 'anima_pencil.safetensors',
    vae: 'qwen_image_vae.safetensors',
    clip1: 'qwen_2.5_vl_7b.safetensors',
  };

  it('CLIPLoader 用 qwen_image 类型,模型过 ModelSamplingAuraFlow(shift 可调)', () => {
    const wf = buildSimpleWorkflow(simple, { ...VALUES, negative: 'blurry' });
    expect(node(wf, '2').inputs).toMatchObject({ clip_name: 'qwen_2.5_vl_7b.safetensors', type: 'qwen_image' });
    expect(node(wf, '6').inputs).toMatchObject({ shift: 3, model: ['1', 0] });
    expect(node(wf, '8').inputs).toMatchObject({ model: ['6', 0], cfg: 4 });
    expect(node(wf, '5').inputs.text).toBe('blurry');
  });

  it('LoRA 链尾接进 AuraFlow 而不是采样器', () => {
    const wf = buildSimpleWorkflow({ ...simple, loras: [{ name: 'a.safetensors', strength: 1 }] }, VALUES);
    expect(node(wf, '6').inputs.model).toEqual(['300', 0]);
  });
});

describe('buildSimpleWorkflow - moss', () => {
  const simple: ComfySimpleConfig = {
    ...simpleDefaults('moss'),
    model: 'moss_image_sft.safetensors',
    vae: 'flux2-vae.safetensors',
    clip1: 'qwen3.5_9b.safetensors',
  };

  it('MOSS 使用 moss_image 编码器和 Flux2 潜空间，正负面及 LoRA 接入同一采样链', () => {
    const wf = buildSimpleWorkflow({...simple,loras:[{name:'style.safetensors',strength:.7}]}, {...VALUES,negative:'blurry'});
    expect(node(wf,'2').inputs).toEqual({clip_name:'qwen3.5_9b.safetensors',type:'moss_image'});
    expect(node(wf,'3').inputs.vae_name).toBe('flux2-vae.safetensors');
    expect(node(wf,'7')).toEqual({class_type:'EmptyFlux2LatentImage',inputs:{width:VALUES.width,height:VALUES.height,batch_size:1}});
    expect(node(wf,'6').inputs).toEqual({shift:5,model:['300',0]});
    expect(node(wf,'4').inputs.clip).toEqual(['2',0]);
    expect(node(wf,'5').inputs).toEqual({text:'blurry',clip:['2',0]});
    expect(node(wf,'8').inputs).toMatchObject({steps:50,cfg:3,sampler_name:'euler',scheduler:'sgm_uniform',model:['6',0],positive:['4',0],negative:['5',0],latent_image:['7',0]});
  });

  it('MOSS 配置持久化后保留模板，仍按 VAE 与 Qwen3.5 逐项校验，不改变默认模板', () => {
    expect(simpleDefaults().template).toBe('checkpoint');
    expect(normalizeSimpleConfig(undefined).template).toBe('checkpoint');
    expect(normalizeSimpleConfig(JSON.parse(JSON.stringify(simple)))).toEqual(simple);
    expect(validateSimpleConfig({...simple,vae:''})).toContain('Flux2 VAE');
    expect(validateSimpleConfig({...simple,clip1:''})).toContain('Qwen3.5-9B');
    expect(validateSimpleConfig(simple)).toBeNull();
    expect(templateSupportsNegative('moss')).toBe(true);
  });
});

describe('buildSimpleWorkflow - 尺寸', () => {
  it('尺寸无效时报错(简易模式的画布节点是必建的,没有「工作流写死尺寸」的豁免)', () => {
    const simple = config({ model: 'm.safetensors' });
    expect(() => buildSimpleWorkflow(simple, { ...VALUES, width: 0 })).toThrow('尺寸');
    expect(() => buildSimpleWorkflow(simple, { ...VALUES, height: 0 })).toThrow('尺寸');
  });
});

describe('normalizeSimpleConfig', () => {
  it('空输入给 checkpoint 默认值', () => {
    expect(normalizeSimpleConfig(undefined)).toEqual(simpleDefaults());
  });

  it('非法 template 回 checkpoint;脏字段逐项归位', () => {
    const normalized = normalizeSimpleConfig({
      template: 'qwen-whatever',
      model: 42,
      steps: 'not a number',
      loras: [{ name: 'a.safetensors', strength: '0.7' }, null, 'junk'],
    });
    expect(normalized.template).toBe('checkpoint');
    expect(normalized.model).toBe('');
    expect(normalized.steps).toBe(28);
    expect(normalized.loras).toEqual([
      { name: 'a.safetensors', strength: 0.7, enabled: true },
      { name: '', strength: 1, enabled: true },
      { name: '', strength: 1, enabled: true },
    ]);
  });

  it('合法 template 的采样参数按该模板默认值兜底', () => {
    expect(normalizeSimpleConfig({ template: 'flux' })).toEqual(simpleDefaults('flux'));
    expect(normalizeSimpleConfig({ template: 'anima' }).shift).toBe(3);
  });
});

describe('LoRA enablement and order', () => {
  it('round-trips disabled rows and order, and enables legacy rows by default', () => {
    const raw={loras:[{name:'c.safetensors',strength:.4,enabled:false},{name:'a.safetensors',strength:1}]};
    const normalized=normalizeSimpleConfig(raw);
    expect(normalized.loras).toEqual([{name:'c.safetensors',strength:.4,enabled:false},{name:'a.safetensors',strength:1,enabled:true}]);
    expect(normalizeSimpleConfig(JSON.parse(JSON.stringify(normalized)))).toEqual(normalized);
  });
  it.each(['checkpoint','flux','anima','moss'] as const)('loads only enabled rows in list order for %s', template => {
    const simple={...simpleDefaults(template),model:'model.safetensors',vae:'vae.safetensors',clip1:'qwen.safetensors',clip2:'clip.safetensors',
      loras:[{name:'legacy.safetensors',strength:1},{name:'disabled.safetensors',strength:.8,enabled:false},{name:'style.safetensors',strength:.4,enabled:true}]};
    const before=JSON.stringify(simple);
    const wf=buildSimpleWorkflow(simple,VALUES);
    expect(node(wf,'300').inputs).toMatchObject({lora_name:'legacy.safetensors',strength_model:1,model:['1',0]});
    expect(node(wf,'301').inputs).toMatchObject({lora_name:'style.safetensors',strength_model:.4,model:['300',0]});
    expect(JSON.stringify(wf)).not.toContain('disabled.safetensors');
    expect(comfySimpleParams(simple).loras).toBe('legacy.safetensors×1、style.safetensors×0.4');
    expect(JSON.stringify(simple)).toBe(before);
    const reordered={...simple,loras:[simple.loras[2],simple.loras[1],simple.loras[0]]};
    const moved=buildSimpleWorkflow(reordered,VALUES);
    expect(node(moved,'300').inputs.lora_name).toBe('style.safetensors');
    expect(node(moved,'301').inputs).toMatchObject({lora_name:'legacy.safetensors',model:['300',0]});
    expect(comfySimpleParams(reordered).loras).toBe('style.safetensors×0.4、legacy.safetensors×1');
    const off={...simple,loras:simple.loras.map(lora=>({...lora,enabled:false}))};
    expect(Object.values(buildSimpleWorkflow(off,VALUES)).some(n=>n.class_type.startsWith('LoraLoader'))).toBe(false);
    expect(comfySimpleParams(off).loras).toBe('');
  });
});

describe('templateSupportsNegative', () => {
  it('flux 无真实负面输入,其余有', () => {
    expect(templateSupportsNegative('flux')).toBe(false);
    expect(templateSupportsNegative('checkpoint')).toBe(true);
    expect(templateSupportsNegative('anima')).toBe(true);
  });
});
