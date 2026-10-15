// 教學影片引擎的公開 API。劇本只需要從這裡 import。

export { startChapter, launchTutorialBrowser, newTutorialPage, Chapter } from './recorder.ts';
export type { ChapterOptions, StepOptions, WaitStableOptions } from './recorder.ts';
export type { StepStatus, Status } from './events.ts';
export { statusLabel, statusSay, SAY_MAX_CHARS } from './events.ts';
export { acquireRecordSlot, newRunDir, DEFAULT_OUT_ROOT, DEFAULT_RECORD_SLOTS } from './runs.ts';
export { geminiProvider, sayProvider, silentProvider, ttsFromEnv, GEMINI_TTS_MODEL } from './tts.ts';
export type { GeminiOptions, GeminiProvider, TtsProvider, Speech } from './tts.ts';
export { renderChapter } from './render.ts';
export { dubChapter, fitSpeech, DUB_GAP_MS, MAX_TEMPO } from './dub.ts';
export type { DubOptions, DubResult } from './dub.ts';
export { buildCues, splitNarration, toSrt, toVtt } from './subtitles.ts';
export type { Cue } from './subtitles.ts';
export type { ChapterMeta } from './render.ts';
export type { ChapterEvents, StatusKind } from './events.ts';
export { assemble, featureTimeline, parseFeatureTable, timecode, timedFeatureTable, youtubeDescription } from './assemble.ts';
