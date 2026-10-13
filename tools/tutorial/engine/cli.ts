// 指令列入口：
//   node engine/cli.ts render <章節資料夾> [--out 檔案.mp4] [--title-ms 2500]
//   node engine/cli.ts assemble --out <資料夾> [--features feature-table.md] <章節資料夾…>

import { parseArgs } from 'node:util';
import { assemble } from './assemble.ts';
import { renderChapter } from './render.ts';

const [cmd, ...rest] = process.argv.slice(2);
const { values, positionals } = parseArgs({
  args: rest,
  allowPositionals: true,
  options: { out: { type: 'string' }, features: { type: 'string' }, 'title-ms': { type: 'string' } },
});

if (cmd === 'render' && positionals.length >= 1) {
  for (const dir of positionals) {
    const { file, meta } = await renderChapter({ dir, out: positionals.length === 1 ? values.out : undefined, titleMs: values['title-ms'] ? Number(values['title-ms']) : undefined });
    console.log(`${file}  ${(meta.durationMs / 1000).toFixed(1)} 秒`);
  }
} else if (cmd === 'assemble' && values.out && positionals.length >= 1) {
  const r = await assemble({ chapters: positionals, outDir: values.out, featureTable: values.features });
  console.log([r.final, r.description, r.featureTimeline, r.html].join('\n'));
  for (const w of r.warnings) console.warn(`注意：${w}`);
} else {
  console.error('用法：\n  cli.ts render <章節資料夾…> [--out 檔案.mp4]\n  cli.ts assemble --out <資料夾> [--features feature-table.md] <章節資料夾…>');
  process.exit(2);
}
