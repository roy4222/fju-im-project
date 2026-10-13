// 教學影片引擎的公開 API。劇本只需要從這裡 import。

export { startChapter, launchTutorialBrowser, newTutorialPage, Chapter } from './recorder.ts';
export type { ChapterOptions, StepOptions } from './recorder.ts';
export { sayProvider, silentProvider } from './tts.ts';
export type { TtsProvider, Speech } from './tts.ts';
export { renderChapter } from './render.ts';
export type { ChapterMeta } from './render.ts';
export type { ChapterEvents, StatusKind } from './events.ts';
