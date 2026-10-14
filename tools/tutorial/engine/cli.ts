// 指令列入口：
//   node engine/cli.ts render <章節資料夾> [--out 檔案.mp4] [--title-ms 2500]
//   node engine/cli.ts assemble --out <資料夾> [--features feature-table.md] <章節資料夾…>
//   TUTORIAL_TTS=gemini TUTORIAL_TTS_VOICE=Charon node engine/cli.ts dub [--out-root ~/work/tutorial-out] [--max-tempo 1.25] <章節資料夾…>

import { homedir } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { assemble } from './assemble.ts';
import { dubChapter } from './dub.ts';
import { renderChapter } from './render.ts';
import { ttsFromEnv } from './tts.ts';

const [cmd, ...rest] = process.argv.slice(2);
const { values, positionals } = parseArgs({
  args: rest,
  allowPositionals: true,
  options: {
    out: { type: 'string' },
    features: { type: 'string' },
    'title-ms': { type: 'string' },
    'out-root': { type: 'string' },
    'max-tempo': { type: 'string' },
  },
});

if (cmd === 'render' && positionals.length >= 1) {
  for (const dir of positionals) {
    const { file, meta } = await renderChapter({ dir, out: positionals.length === 1 ? values.out : undefined, titleMs: values['title-ms'] ? Number(values['title-ms']) : undefined });
    console.log(`${file}  ${(meta.durationMs / 1000).toFixed(1)} 秒`);
  }
} else if (cmd === 'assemble' && values.out && positionals.length >= 1) {
  const r = await assemble({ chapters: positionals, outDir: values.out, featureTable: values.features });
  console.log([r.final, r.description, r.featureTimeline, r.html, r.srt, r.vtt].filter(Boolean).join('\n'));
  for (const w of r.warnings) console.warn(`注意：${w}`);
} else if (cmd === 'dub' && positionals.length >= 1) {
  const tts = ttsFromEnv();
  const root = join(values['out-root'] ?? join(homedir(), 'work', 'tutorial-out'), `dub-${tts.voice}`);
  const failed: string[] = [];
  for (const dir of positionals) {
    const id = dir.replace(/\/+$/, '').split('/').at(-1)!;
    try {
      const r = await dubChapter({ dir, tts, outDir: join(root, id), maxTempo: values['max-tempo'] ? Number(values['max-tempo']) : undefined, titleMs: values['title-ms'] ? Number(values['title-ms']) : undefined });
      const sped = r.steps.filter((s) => s.tempo > 1).map((s) => `第 ${s.index} 步 ${s.tempo} 倍`);
      console.log(`${r.file}  最快 ${r.maxTempo} 倍${sped.length ? `（${sped.join('、')}）` : '（全部原速）'}\n${r.srt}`);
    } catch (e) {
      failed.push(id);
      console.error((e as Error).message);
    }
  }
  if ('stats' in tts) {
    const { calls, cacheHits } = (tts as { stats: { calls: number; cacheHits: number } }).stats;
    console.log(`TTS：${tts.name} ${tts.voice}，API 呼叫 ${calls} 次、快取命中 ${cacheHits} 句`);
  }
  if (failed.length) {
    console.error(`沒有完成：${failed.join('、')}`);
    process.exit(1);
  }
} else {
  console.error(
    [
      '用法：',
      '  cli.ts render <章節資料夾…> [--out 檔案.mp4]',
      '  cli.ts assemble --out <資料夾> [--features feature-table.md] <章節資料夾…>',
      '  TUTORIAL_TTS=gemini TUTORIAL_TTS_VOICE=Charon cli.ts dub [--out-root <資料夾>] [--max-tempo 1.25] <章節資料夾…>',
    ].join('\n'),
  );
  process.exit(2);
}
