/**
 * Shared contracts between the analyzer, the planner, the mixer engine and the apps.
 * Everything here is plain JSON-serializable data so it can be stored in SQLite,
 * sent to an AudioWorklet and, later, to a native mobile engine.
 */

export const ANALYZER_VERSION = 'am-analyzer-14';
export const PLANNER_VERSION = 'am-planner-v13-length-1';

/** Frame rate of the per-track feature curves (energy, bands, waveform). */
export const CURVE_RATE = 20;
/** Largest voice mask: B's first words at full level while its accompaniment is still at -8 dB. */
export const VOICE_LIFT_MAX = 2.5;

export interface BeatGrid {
  /** Tempo in BPM of the beat grid (already resolved for half/double ambiguity). */
  bpm: number;
  /** 0..1, combines periodicity strength and consistency across the track. */
  confidence: number;
  /** Seconds per beat from the regression over all beats. */
  period: number;
  /** True when beats follow a constant tempo (residual jitter small). */
  stable: boolean;
  /** Residual standard deviation of beats against the constant grid, ms. */
  jitterMs: number;
  /** Beat positions in seconds. */
  beats: number[];
  /** Bar start positions in seconds (4/4 assumed). */
  downbeats: number[];
  downbeatConfidence: number;
  /** Index into `beats` of the first downbeat. */
  downbeatPhase: number;
  /** Other tempo hypotheses that were considered (octave errors etc). */
  alternatives: { bpm: number; score: number }[];
  /** Per-beat drum accents aligned with `beats`; absent in older analyses. */
  accents?: BeatAccents;
  /** Sparse confident low-frequency attack offsets aligned with beats. */
  attacks?: { version: 'lf-attack-1'; offsetsMs: (number | null)[]; strength: number[] };
}

/** Attack strength at each beat, divided by its median over the grid:
 * `kick` below 150 Hz, `snare` in 1-4 kHz (snares, claps; hats are mostly above).
 * Band energies, not a drum transcription. */
export interface BeatAccents {
  kick: number[];
  snare: number[];
}

export interface KeyInfo {
  /** Pitch class of the tonic, 0 = C. -1 when unknown. */
  tonic: number;
  mode: 'major' | 'minor' | 'unknown';
  /** Human readable name, e.g. "A minor". */
  name: string;
  /** Camelot code, e.g. "8A". Empty string when unknown. */
  camelot: string;
  confidence: number;
}

/** A measured constant-pulse region, usable even when the song changes tempo.
 * Beat and downbeat times are absolute seconds in the original audio. */
export interface BeatRegion {
  start: number;
  end: number;
  bpm: number;
  period: number;
  confidence: number;
  jitterMs: number;
  beats: number[];
  downbeats: number[];
  downbeatConfidence: number;
  downbeatPhase: number;
  accents?: BeatAccents;
}

export interface LoudnessInfo {
  /** ITU-R BS.1770-4 integrated loudness, LUFS. */
  integratedLufs: number;
  /** Estimated true peak (4x oversampled), dBTP. */
  truePeakDb: number;
  samplePeakDb: number;
}

export interface CueCandidate {
  /** Seconds in the track. */
  time: number;
  /** 0..1 suitability. */
  score: number;
  kind: 'phrase' | 'downbeat' | 'section' | 'start' | 'energy';
  /** Short machine readable reasons, e.g. ["outro", "low-mid-density"]. */
  tags: string[];
}

export interface Section {
  start: number;
  end: number;
}

/** Measured structural regions; these do not identify vocals, verses or choruses. */
export interface MusicalSection extends Section {
  rmsDb: number;
  midDensity: number;
  /** Strength of the acoustic change at `start`, 0..1. */
  novelty: number;
}

/** Song structure from repetition on a chroma + MFCC self-similarity matrix.
 * No lyrics, vocals or learned labels: "repeat" means the music recurs, and a
 * chorus is only a scored hypothesis (`chorusLikelihood`, `likelyChorus`). */
export interface SongStructure {
  method: 'ssm-repeat-1';
  /** Contiguous partition of the audible range. */
  segments: StructureSegment[];
  /** Material heard at least twice; ids are indices into this array. */
  groups: RepeatGroup[];
  /** Best chorus hypothesis (most repeated, loudest, clearly ahead); absent when the evidence is weak.
   * A heuristic without lyrics or vocals, so `confidence` stays <= 0.9. */
  likelyChorus?: { group: number; confidence: number; tags: string[] };
  /** Share of the audible range inside a repeated segment, 0..1. */
  repetitionCoverage: number;
  /** Repetition lags measured in beats of the global grid: an onset-independent check of its tempo and meter. */
  gridCheck?: {
    lags: number;
    /** Share of lags within 0.15 beat of a whole number of beats. */
    beatIntegerShare: number;
    /** Among those, share that is a whole number of 4-beat bars, and share that is a multiple of 3 but not of 4 beats. */
    barIntegerShare: number;
    tripleShare: number;
    /** Median distance of a lag from the nearest whole beat, beats. */
    medianBeatError: number;
    /** The measured lags, beats (diagnostics; at most 24). */
    lagBeats?: number[];
    /** Set when the lags are not whole beats of this grid but are whole beats of a 2:3, 4:3, 3:2 or 3:4
     * related tempo (bpm closest to 120 among those): a likely tempo error of the grid, not a measured grid. */
    periodHint?: { bpm: number; share: number };
  };
}

export interface StructureSegment {
  start: number;
  end: number;
  /** Repeat group id, or -1 for material heard once. */
  group: number;
  /** Occurrence index within the group (0 = first time heard); -1 when unique. */
  occurrence: number;
  /** Mean similarity of this segment to its best match elsewhere, 0..1. */
  repeatSimilarity: number;
  /** Group's chorus heuristic score, 0..1; 0 for unique material. Not a lyric/vocal label. */
  chorusLikelihood: number;
  /** Mean RMS level, dBFS, and its difference to the track body level, dB. */
  rmsDb: number;
  relDb: number;
  /** Level trend inside the segment, dB per 10 s (build-ups > 0, fades < 0). */
  slopeDb: number;
  /** Boundary strength at `start`, 0..1. */
  novelty: number;
  /** 0..1 how strongly a musical unit closes at `end`: repeat ends, boundary strength, bar grid. */
  endClosure: number;
}

export interface RepeatGroup {
  id: number;
  occurrences: Section[];
  /** Mean path similarity of the repetitions, 0..1. */
  similarity: number;
  /** Mean level difference to the track body, dB. */
  relDb: number;
  chorusLikelihood: number;
}

/** Normalized descriptors used by the recommender. All roughly 0..1. */
export interface TrackFeatures {
  energy: number;
  brightness: number;
  rhythmStrength: number;
  onsetRate: number;
  bassWeight: number;
  midDensity: number;
  dynamics: number;
  acousticness: number;
}

export interface TrackAnalysis {
  version: string;
  duration: number;
  /** First and last audible moments (silence trimmed). */
  audibleStart: number;
  audibleEnd: number;
  loudness: LoudnessInfo;
  /** Null when the track has no reliable pulse (ambient, rubato, speech). */
  beat: BeatGrid | null;
  /** Locally reliable grids; gaps and tempo changes are deliberately excluded. */
  beatRegions?: BeatRegion[];
  /** Estimated vocal presence from actual local source separation, not EQ density. */
  vocalActivity?: {
    rate: number;
    values: number[];
    source: 'demucs';
    model: string;
    /** Feature version; absent in existing stem caches. */
    version?: string;
    /** Content identity of a published vocal feature/PCM generation. */
    revision?: string;
    /** Measured, unsmoothed stereo RMS per activity frame, dBFS. */
    vocalRmsDb?: number[];
    accompanimentRmsDb?: number[];
    /** Acoustic vocal phrases, not lyrics or verse/chorus labels. */
    phrases?: { start: number; end: number; confidence: number }[];
    /** Sung word and line timing from local speech recognition (Whisper) on the separated
     * voice, seconds. No text. `confidence` is the median word probability. */
    lyrics?: { version: string; language: string | null; confidence: number; words: [number, number][]; lines: [number, number][];
      /** 'stem-verified-1': `voiced` was measured on the separated voice at 10 ms. Whisper word
       * edges alone are not edit-accurate on singing. */
      timing?: string; voiced?: [number, number][] };
  };
  /** 0..1 strength of a periodic pulse. */
  rhythmStrength: number;
  key: KeyInfo;
  /** Phrase boundaries (seconds), usually every 8 bars. */
  phrases: number[];
  phraseConfidence: number;
  /** Strong structural changes (seconds) found by novelty detection. */
  sectionBoundaries: number[];
  /** Optional for compatibility with previously cached analyses. */
  sections?: MusicalSection[];
  /** Repetition structure; absent in older analyses and for silent/very short audio. */
  structure?: SongStructure;
  intro: Section;
  outro: Section;
  /** Energy level of the main body of the track, dBFS RMS. */
  bodyRmsDb: number;
  curves: {
    rate: number;
    /** RMS level in dBFS per frame. */
    rmsDb: number[];
    /** Band energies, dB, per frame. */
    lowDb: number[];
    midDb: number[];
    highDb: number[];
    /**
     * Heuristic: harmonic density in the 250-4000 Hz band (0..1).
     * Not a vocal detector: lead synths and guitars raise it too.
     */
    midDensity: number[];
  };
  /** Local harmony and attacks around each second (analyzer-13); absent in older analyses.
   * `camelot` is '' where the 8 s window has no reliable key: modulations and harmony-poor
   * passages stay unknown rather than inheriting the global key. */
  local?: {
    rate: number;
    camelot: string[];
    keyConfidence: number[];
    /** Onset peaks per second over 2 s, scaled 0..1 at 8/s. Not a drum or voice detector. */
    transients: number[];
  };
  /** Downsampled waveform peaks for drawing, 0..1, at `curves.rate`. */
  peaks: number[];
  cues: { entry: CueCandidate[]; exit: CueCandidate[] };
  features: TrackFeatures;
  warnings: string[];
  /** Time spent analyzing, ms. */
  elapsedMs: number;
}

export type TransitionMethod =
  | 'beatmatch_blend'
  | 'tempo_bridge'
  | 'drop_mix'
  | 'phrase_cut'
  | 'crossfade'
  | 'echo_out'
  | 'gapless'
  | 'fallback_crossfade'
  | 'skip_fade';

/** Listener verdict on an executed transition; reasons are fixed tags so ratings can be aggregated. */
export type TransitionRating = 'good' | 'bad';
export const TRANSITION_RATING_REASONS = ['голоса наложились', 'провал громкости', 'резко', 'сбился ритм'] as const;
export type TransitionRatingReason = (typeof TRANSITION_RATING_REASONS)[number];

/** 'filter' is bipolar (-1 low-pass, 0 bypass, +1 high-pass).
 * 'echo' is a send level (0..1) into a tempo-synced echo; gain/low/mid/high are gains.
 * 'voiceEcho' sends only the audible separated voice of A into its own echo (vocal throw). */
export type Lane = 'gain' | 'low' | 'mid' | 'high' | 'echo' | 'voiceEcho' | 'filter';

/** A piecewise-linear automation lane. `t` is seconds from transition start (output time). */
export interface AutomationLane {
  deck: 'A' | 'B';
  lane: Lane;
  points: [number, number][];
}

export interface TransitionPlan {
  id: string;
  version: string;
  fromTrackId: string;
  toTrackId: string;
  method: TransitionMethod;
  /** 0..1 how sure the planner is that this will sound right. */
  confidence: number;
  /** Human readable reasons in Russian for UI and logs. */
  reasons: string[];
  /** Why a simpler method was used instead of a beatmatched blend. */
  fallbackReason?: string;
  /** Track A time (s) where the transition starts. */
  aExit: number;
  /** Track B time (s) that plays at transition start. */
  bEntry: number;
  /** Overlap length in output seconds. 0 for a gapless join. */
  duration: number;
  /** Silence (s) inserted between A and B (gapless with gap only). */
  gap: number;
  /** Output time (s from start) where "now playing" switches to B. */
  swapAt: number;
  /** B playback speed (track seconds per output second) as piecewise-linear points over output time. */
  tempoB: [number, number][];
  /**
   * Optional A playback speed during the transition (tempo glide). When set,
   * A and B change speed together so their beats stay locked while the
   * common tempo glides from A's BPM to B's BPM.
   */
  tempoA?: [number, number][];
  /** Finite instrumental A loop; source seconds, preroll included in vocal safety checks. */
  loopA?: { start: number; end: number; until: number; crossfade: number; roll?: { at: number; length: number }[] };
  /** Intentional finite rate/pitch slowdown, absolute A source seconds. */
  tapeStopA?: { start: number; end: number; crossfade: number };
  /** Seconds into the overlap before B starts (B holds at bEntry). B's lanes, tempoB and vocalB run on B's
   * own clock from that moment; A's lanes, tempoA, vocalA and swapAt stay on the transition clock. */
  bDelay?: number;
  /** Vocal-only amplitude, applied before stretching; requires synchronized vocal PCM.
   * Values above 1 (up to VOICE_LIFT_MAX) lift the voice over a deck whose gain is still low. */
  vocalA?: [number, number][];
  vocalB?: [number, number][];
  automation: AutomationLane[];
  /** Tempo-synced echo used by the 'echo' send lane (echo-out of A). */
  echo?: { delay: number; feedback: number };
  /** Echo used by the 'voiceEcho' lane: repeats A's last sung word and dies out before B's voice opens. */
  voiceEcho?: { delay: number; feedback: number; clearAt?: number };
  /** Static loudness normalization gains, dB. */
  gainA: number;
  gainB: number;
  beatAlign?: {
    bpmA: number;
    bpmB: number;
    /** B beats per A beat factor used: 0.5, 1 or 2. */
    relation: number;
    ratio: number;
    stretchPercent: number;
    /** True when the common tempo glides from A to B during the overlap. */
    glide?: boolean;
    /** A stays native; B recovers after A leaves. */
    masterDeck?: 'A';
    recoverySeconds?: number;
    /** Both decks meet at this intermediate BPM; B recovers its native tempo solo. */
    bridge?: { commonBpm: number; lockAt: number; recoverySeconds: number };
    overlapBeats: number;
    phraseAligned: boolean;
    regions?: Partial<Record<'A'|'B',{start:number;end:number;period:number;downbeat:number}>>;
  };
  keyInfo?: { a: string; b: string; compatibility: number; label: string };
  /** Why music before B's entry was skipped; no semantic chorus/vocal detection is implied. */
  entrySelection?: {
    kind: 'start' | 'intro-trim' | 'section';
    skippedSeconds: number;
    /** B time of the structural arrival/downbeat at the handoff. */
    arrivalTime?: number;
    confidence: number;
  };
  /** Debug information about rejected options. */
  debug: Record<string, unknown>;
}

export interface AutoMixSettings {
  enabled: boolean;
  /** Max tempo difference (percent) bridged by a beatmatched tempo glide. */
  maxStretchPercent: number;
  /** Upper limit for overlap length, seconds. */
  maxBlendSeconds: number;
  /** Bass/mid/high handoff. */
  eqHandoff: boolean;
  /** Gapless joins between consecutive album tracks. */
  respectAlbums: boolean;
  /** Loudness normalization target, LUFS, or null to disable. */
  loudnessTarget: number | null;
  /** 'auto' picks per pair; 'smooth' prefers long blends; 'tight' prefers short ones. */
  style: 'auto' | 'smooth' | 'tight';
  /** Fallback crossfade length when analysis is missing, seconds. */
  fallbackSeconds: number;
  /** Preserve every musical opening, or allow analysis to choose a later entry. */
  entryMode?: 'smart' | 'preserve';
  /** Maximum music skipped before an automatic entry (silence does not count). */
  maxEntrySkipSeconds?: number;
  /** First Next press uses a short musical transition; a repeat press skips fast. */
  mixOnNext?: boolean;
  /** Use locally separated vocals when prepared; other methods remain available. */
  stemMixing?: boolean;
  /** Allow finite measured instrumental loops in decaying outros. */
  loopBridges?: boolean;
  /** Keep outgoing vocals at native tempo on small, measured beat locks. */
  masterTempo?: boolean;
  /** Filter build / echo release at measured instrumental section arrivals. */
  djPhrasing?: boolean;
}

export const DEFAULT_AUTOMIX_SETTINGS: AutoMixSettings = {
  enabled: true,
  maxStretchPercent: 12,
  maxBlendSeconds: 32,
  eqHandoff: true,
  respectAlbums: true,
  loudnessTarget: -16,
  style: 'auto',
  fallbackSeconds: 6,
  entryMode: 'smart',
  maxEntrySkipSeconds: 45,
  mixOnNext: true,
  stemMixing: true,
  loopBridges: true,
  masterTempo: true,
  djPhrasing: true,
};

/** Minimal track info the planner needs besides analysis. */
export interface PlannerTrack {
  id: string;
  duration: number;
  album?: string | null;
  albumArtist?: string | null;
  trackNo?: number | null;
  discNo?: number | null;
  /** Whether the provider allows analysis/mixing. */
  mixingAllowed: boolean;
  analysis: TrackAnalysis | null;
}
