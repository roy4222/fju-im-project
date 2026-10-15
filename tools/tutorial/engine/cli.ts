// 指令列入口：
//   node engine/cli.ts render <章節資料夾> [--out 檔案.mp4] [--title-ms 2500]
//   node engine/cli.ts assemble --out <資料夾> [--features feature-table.md] <章節資料夾…>
//   TUTORIAL_TTS=gemini TUTORIAL_TTS_VOICE=Charon node engine/cli.ts dub [--out-root ~/work/tutorial-out] [--max-tempo 1.3] <章節資料夾…>

import { homedir } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { assemble } from './assemble.ts';
import { checkMaxTempo, dubBatch, WARN_TEMPO } from './dub.ts';
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
  let maxTempo: number | undefined;
  try {
    maxTempo = values['max-tempo'] != null ? checkMaxTempo(Number(values['max-tempo'])) : undefined;
  } catch (e) {
    console.error((e as Error).message);
    process.exit(2);
  }
  const tts = ttsFromEnv();
  const outRoot = join(values['out-root'] ?? join(homedir(), 'work', 'tutorial-out'), `dub-${tts.voice}`);
  const r = await dubBatch(positionals, {
    tts,
    outRoot,
    maxTempo,
    titleMs: values['title-ms'] ? Number(values['title-ms']) : undefined,
    onDone: (_id, d) => {
      const sped = d.steps.filter((s) => s.tempo > 1).map((s) => `第 ${s.index} 步 ${s.tempo.toFixed(3)} 倍`);
      console.log(`${d.file}  最快 ${d.maxTempo.toFixed(3)} 倍${sped.length ? `（${sped.join('、')}）` : '（全部原速）'}\n${d.srt}`);
      for (const s of d.steps.filter((x) => x.tempo > WARN_TEMPO)) console.warn(`注意：${_id} 第 ${s.index} 步加速 ${s.tempo.toFixed(3)} 倍（超過 ${WARN_TEMPO}）`);
    },
    onFail: (_id, e) => console.error(e.message),
  });
  if ('stats' in tts) {
    const { calls, cacheHits } = (tts as { stats: { calls: number; cacheHits: number } }).stats;
    console.log(`TTS：${tts.name} ${tts.voice}，API 呼叫 ${calls} 次、快取命中 ${cacheHits} 句`);
  }
  if (r.quota) console.error(`OpenRouter 沒額度，整批停下；沒做的：${r.skipped.join('、') || '（無）'}`);
  if (r.failed.length || r.skipped.length) {
    console.error(`沒有完成：${[...r.failed, ...r.skipped].join('、')}`);
    process.exit(1);
  }
} else {
  console.error(
    [
      '用法：',
      '  cli.ts render <章節資料夾…> [--out 檔案.mp4]',
      '  cli.ts assemble --out <資料夾> [--features feature-table.md] <章節資料夾…>',
      '  TUTORIAL_TTS=gemini TUTORIAL_TTS_VOICE=Charon cli.ts dub [--out-root <資料夾>] [--max-tempo 1.3] <章節資料夾…>',
    ].join('\n'),
  );
  process.exit(2);
}
