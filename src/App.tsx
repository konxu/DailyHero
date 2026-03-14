import React, { useState, useRef, useEffect, useCallback } from 'react';
import { Camera, AlertCircle, Activity, Shield, Info, Settings, RefreshCw, Volume2, VolumeX, Phone, X } from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import { GoogleGenAI, Modality, LiveServerMessage, Type } from "@google/genai";
import Markdown from 'react-markdown';

// --- Types ---
declare global {
  interface Window {
    aistudio?: {
      hasSelectedApiKey: () => Promise<boolean>;
      openSelectKey: () => Promise<void>;
    };
    webkitAudioContext: typeof AudioContext;
  }
}

interface AnalysisResult {
  description: string;
  painDetected: boolean;
  painLevel?: number; 
  guidance?: string;
  isChoking?: boolean;
  isUnconscious?: boolean;
  needsCPR?: boolean;
  timestamp: string;
}

const CPR_BPM = 110; // Target 100-120 bpm

// PCM Audio Player for Live API with Queue to prevent overlapping voices
class PCMAudioPlayer {
  private audioContext: AudioContext | null = null;
  private nextStartTime: number = 0;
  private sampleRate: number = 24000;
  private isProcessing: boolean = false;
  private queue: string[] = [];
  private sources: AudioBufferSourceNode[] = [];

  public onPlaybackStateChange?: (isSpeaking: boolean) => void;

  private activeSourceCount: number = 0;

  constructor(sampleRate: number = 24000, onPlaybackStateChange?: (isSpeaking: boolean) => void) {
    this.sampleRate = sampleRate;
    this.onPlaybackStateChange = onPlaybackStateChange;
  }

  private updateSpeakingState() {
    this.onPlaybackStateChange?.(this.activeSourceCount > 0);
  }

  async play(base64Data: string) {
    if (!base64Data) return;
    
    // If the queue is too long (e.g., > 50 seconds of audio), clear it to stay real-time
    // Each chunk is roughly 100ms. 500 chunks = 50s.
    if (this.queue.length > 500) {
      console.warn(`PCMAudioPlayer: Queue too long (${this.queue.length} chunks). Dropping old audio.`);
      this.queue = this.queue.slice(-20); // Keep only the most recent 20 chunks
    }

    this.queue.push(base64Data);
    this.processQueue();
  }

  stop() {
    console.log("PCMAudioPlayer: Stopping all playback");
    this.queue = [];
    this.sources.forEach(source => {
      try {
        source.stop();
      } catch (e) {}
    });
    this.sources = [];
    this.nextStartTime = 0;
    this.activeSourceCount = 0;
    this.updateSpeakingState();
  }

  private async processQueue() {
    if (this.isProcessing) return;
    this.isProcessing = true;

    while (this.queue.length > 0) {
      const data = this.queue.shift();
      if (data) {
        await this._playChunk(data);
      }
    }

    this.isProcessing = false;
  }

  private async _playChunk(base64Data: string) {
    const ctx = this.audioContext || new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: this.sampleRate });
    if (!this.audioContext) {
      console.log("PCMAudioPlayer: Initializing AudioContext");
      this.audioContext = ctx;
      this.nextStartTime = ctx.currentTime;
    }

    if (ctx.state === 'suspended') {
      await ctx.resume().catch(e => console.error("PCMAudioPlayer: Resume failed", e));
    }

    try {
      const binaryString = atob(base64Data);
      const bytes = new Uint8Array(binaryString.length);
      for (let i = 0; i < binaryString.length; i++) {
        bytes[i] = binaryString.charCodeAt(i);
      }
      
      const pcmData = new Int16Array(Math.floor(bytes.length / 2));
      const view = new DataView(bytes.buffer);
      for (let i = 0; i < pcmData.length; i++) {
        pcmData[i] = view.getInt16(i * 2, true);
      }

      const float32Data = new Float32Array(pcmData.length);
      for (let i = 0; i < pcmData.length; i++) {
        float32Data[i] = pcmData[i] / 32768.0;
      }

      const buffer = ctx.createBuffer(1, float32Data.length, this.sampleRate);
      buffer.copyToChannel(float32Data, 0);

      const source = ctx.createBufferSource();
      source.buffer = buffer;
      
      const gainNode = ctx.createGain();
      gainNode.gain.value = 1.0;
      source.connect(gainNode);
      gainNode.connect(ctx.destination);

      const now = ctx.currentTime;
      
      // Only reset nextStartTime if it's significantly behind or at start
      if (this.nextStartTime < now) {
        this.nextStartTime = now;
      }
      
      // If nextStartTime is too far in the future (more than 20s), clear and reset to stay real-time
      if (this.nextStartTime > now + 20.0) {
        console.warn(`PCMAudioPlayer: Audio queue is getting long (${(this.nextStartTime - now).toFixed(2)}s). Resetting.`);
        this.stop(); // Stop all current playback
        this.nextStartTime = now;
        // Trigger a custom event to notify UI
        window.dispatchEvent(new CustomEvent('audio-queue-reset'));
      }
      
      const startTime = this.nextStartTime;
      source.start(startTime);
      this.nextStartTime = startTime + buffer.duration;
      
      this.activeSourceCount++;
      this.updateSpeakingState();

      this.sources.push(source);
      source.onended = () => {
        this.sources = this.sources.filter(s => s !== source);
        this.activeSourceCount--;
        this.updateSpeakingState();
      };
    } catch (e) {
      console.error("PCMAudioPlayer: Play error", e);
    }
  }

  unlock() {
    console.log("PCMAudioPlayer: Unlocking AudioContext...");
    if (!this.audioContext) {
      this.audioContext = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: this.sampleRate });
    }
    if (this.audioContext.state === 'suspended') {
      this.audioContext.resume();
    }
    // Play a tiny silent buffer to fully unlock
    try {
      const buffer = this.audioContext.createBuffer(1, 1, this.sampleRate);
      const source = this.audioContext.createBufferSource();
      source.buffer = buffer;
      source.connect(this.audioContext.destination);
      source.start();
    } catch (e) {}
  }
}

const CHOKING_STEPS_ALONE = [
  "Lean over chair/desk",
  "Press abdomen on edge",
  "Push down hard"
];

const CHOKING_STEPS_BYSTANDER = [
  "Stand behind & wrap",
  "Fist above navel",
  "Upward thrusts"
];

export default function App() {
  const isAnalyzingRef = useRef(false);
  const [isAnalyzing, setIsAnalyzingState] = useState(false);
  
  const setIsAnalyzing = (val: boolean) => {
    if (isAnalyzingRef.current !== val) {
      console.log(`Live API: [ANALYZING STATE CHANGE] ${isAnalyzingRef.current} -> ${val}`);
    }
    isAnalyzingRef.current = val;
    setIsAnalyzingState(val);
  };
  const [isConnecting, setIsConnecting] = useState(false);
  const [hasApiKey, setHasApiKey] = useState(false);
  const [stream, setStream] = useState<MediaStream | null>(null);
  const [lastResult, setLastResult] = useState<AnalysisResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const isVoiceEnabledRef = useRef(true);
  const [isVoiceEnabled, setIsVoiceEnabledState] = useState(true);
  const [emergencyButtons, setEmergencyButtons] = useState<string[]>([]);
  const [emergencyQuestion, setEmergencyQuestion] = useState<string | null>(null);
  const [currentRescueStep, setCurrentRescueStepState] = useState<string | null>(null);
  const currentRescueStepRef = useRef<string | null>(null);
  const setCurrentRescueStep = (val: string | null) => {
    currentRescueStepRef.current = val;
    setCurrentRescueStepState(val);
  };
  const [rescueStepIndex, setRescueStepIndex] = useState(-1);
  
  const [detectedScenario, setDetectedScenario] = useState<string | null>(null);
  const [userLocation, setUserLocation] = useState<string>("Detecting location...");
  const isTurnActiveRef = useRef(false);
  const isModelGeneratingRef = useRef(false);
  const [isModelGenerating, setIsModelGeneratingState] = useState(false);
  const setIsModelGenerating = (val: boolean) => {
    setIsModelGeneratingState(val);
    isModelGeneratingRef.current = val;
  };

  // Watchdog for model generation state
  useEffect(() => {
    if (isModelGenerating) {
      const timer = setTimeout(() => {
        if (isModelGeneratingRef.current) {
          console.log("Live API: [WATCHDOG] Model generating state timed out.");
          setIsModelGenerating(false);
        }
      }, 10000); // 10s timeout
      return () => clearTimeout(timer);
    }
  }, [isModelGenerating]);

  useEffect(() => {
    const handleAudioReset = () => {
      addStatusLog("Audio Syncing...", "amber");
    };
    window.addEventListener('audio-queue-reset', handleAudioReset);
    return () => window.removeEventListener('audio-queue-reset', handleAudioReset);
  }, []);

  useEffect(() => {
    audioPlayerRef.current.onPlaybackStateChange = (speaking) => {
      setIsSpeaking(speaking);
      if (!speaking && !isModelGeneratingRef.current) {
        isTurnActiveRef.current = false;
      }
    };
  }, []);

  useEffect(() => {
    if ("geolocation" in navigator) {
      navigator.geolocation.getCurrentPosition(
        async (position) => {
          const { latitude, longitude } = position.coords;
          try {
            const response = await fetch(`https://nominatim.openstreetmap.org/reverse?format=json&lat=${latitude}&lon=${longitude}`);
            const data = await response.json();
            if (data.display_name) {
              setUserLocation(data.display_name);
            } else {
              setUserLocation(`${latitude.toFixed(4)}, ${longitude.toFixed(4)}`);
            }
          } catch (e) {
            setUserLocation(`${latitude.toFixed(4)}, ${longitude.toFixed(4)}`);
          }
        },
        (err) => {
          console.error("Geolocation error:", err);
          setUserLocation("Location unavailable");
        }
      );
    }
  }, []);

  const setIsVoiceEnabled = (val: boolean) => {
    isVoiceEnabledRef.current = val;
    setIsVoiceEnabledState(val);
  };
  const [isSpeaking, setIsSpeakingState] = useState(false);
  const isSpeakingRef = useRef(false);
  const setIsSpeaking = (val: boolean) => {
    isSpeakingRef.current = val;
    setIsSpeakingState(val);
  };
  const isRescueModeRef = useRef(false);
  const [isRescueMode, setIsRescueModeState] = useState(false);
  const [isBystanderLed, setIsBystanderLedState] = useState(false);
  const isBystanderLedRef = useRef(false);
  const setIsBystanderLed = (val: boolean) => {
    isBystanderLedRef.current = val;
    setIsBystanderLedState(val);
  };
  const [activeAssignments, setActiveAssignmentsState] = useState<any[]>([]);
  const activeAssignmentsRef = useRef<any[]>([]);
  const setActiveAssignments = (val: any[]) => {
    activeAssignmentsRef.current = val;
    setActiveAssignmentsState(val);
  };
  const [videoDimensions, setVideoDimensions] = useState({ width: 0, height: 0 });
  const [containerSize, setContainerSize] = useState({ width: 0, height: 0 });
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const updateSize = () => {
      if (containerRef.current) {
        const rect = containerRef.current.getBoundingClientRect();
        setContainerSize({
          width: rect.width,
          height: rect.height
        });
      }
    };

    const observer = new ResizeObserver(updateSize);
    if (containerRef.current) {
      observer.observe(containerRef.current);
    }
    
    window.addEventListener('resize', updateSize);
    updateSize();
    
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', updateSize);
    };
  }, []);

  useEffect(() => {
    const updateVideoDims = () => {
      if (videoRef.current && videoRef.current.videoWidth > 0) {
        setVideoDimensions({
          width: videoRef.current.videoWidth,
          height: videoRef.current.videoHeight
        });
      }
    };
    
    updateVideoDims();
    const interval = setInterval(updateVideoDims, 1000);
    return () => clearInterval(interval);
  }, [stream]);

  const onVideoMetadata = () => {
    if (videoRef.current) {
      setVideoDimensions({
        width: videoRef.current.videoWidth,
        height: videoRef.current.videoHeight
      });
    }
  };
  const [isCalling, setIsCallingState] = useState(false);
  const isCallingRef = useRef(false);
  const setIsCalling = (val: boolean) => {
    isCallingRef.current = val;
    setIsCallingState(val);
  };
  const [callStatus, setCallStatus] = useState<string | null>(null);
  
  const setIsRescueMode = (val: boolean) => {
    if (isRescueModeRef.current !== val) {
      console.log(`Live API: [RESCUE MODE CHANGE] ${isRescueModeRef.current} -> ${val}`);
    }
    isRescueModeRef.current = val;
    setIsRescueModeState(val);
  };

  const [transcription, setTranscription] = useState("");
  const [isHearing, setIsHearing] = useState(false);
  const [statusLogs, setStatusLogs] = useState<{ text: string, color: string }[]>([]);

  const addStatusLog = useCallback((text: string, color: string = '#10b981') => {
    setStatusLogs(prev => [{ text, color }, ...prev].slice(0, 5));
  }, []);
  
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const aiRef = useRef<GoogleGenAI | null>(null);
  const sessionRef = useRef<any>(null);
  const sessionIdRef = useRef<number>(0);
  const audioPlayerRef = useRef<PCMAudioPlayer>(new PCMAudioPlayer(24000, (speaking) => {
    setIsSpeaking(speaking);
  }));
  const frameRequestRef = useRef<number | null>(null);
  const lastFrameTimeRef = useRef<number>(0);
  const lastAiTurnTimeRef = useRef<number>(Date.now());
  const lastServerMessageTimeRef = useRef<number>(0);

  // Check for API Key selection
  useEffect(() => {
    const checkKey = async () => {
      if (window.aistudio?.hasSelectedApiKey) {
        const selected = await window.aistudio.hasSelectedApiKey();
        setHasApiKey(selected);
      } else {
        setHasApiKey(true);
      }
    };
    checkKey();
  }, []);

  const isStreamingRef = useRef<boolean>(false);
  const speakingTimeoutRef = useRef<any>(null);

  const openKeySelector = async () => {
    if (window.aistudio?.openSelectKey) {
      await window.aistudio.openSelectKey();
      setHasApiKey(true);
    }
  };

  const [bystanderNudgeCount, setBystanderNudgeCount] = useState(0);
  const bystanderNudgeCountRef = useRef(0);

  const resetRescueState = useCallback((reason: string = "unknown") => {
    console.log(`Live API: [RESET RESCUE STATE] Reason: ${reason}`);
    setIsRescueMode(false);
    setIsBystanderLed(false);
    setEmergencyButtons([]);
    setEmergencyQuestion(null);
    setCurrentRescueStep(null);
    setRescueStepIndex(-1);
    setActiveAssignments([]);
    setIsCalling(false);
    setCallStatus(null);
    setIsSpeaking(false);
    setTranscription("");
    setStatusLogs([]);
    setDetectedScenario(null);
    setLastResult(null);
    setBystanderNudgeCount(0);
    bystanderNudgeCountRef.current = 0;
    isStreamingRef.current = false;
    lastAiTurnTimeRef.current = Date.now();
  }, []);

  const startCamera = async () => {
    setError(null);
    setIsConnecting(true);
    resetRescueState("startCamera"); // Reset everything before starting
    
    // Unlock audio context on user gesture
    audioPlayerRef.current.unlock();

    try {
      const mediaStream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: 'user', width: { ideal: 640 }, height: { ideal: 480 } },
        audio: true // Enable audio for Live API stability
      });
      setStream(mediaStream);
      if (videoRef.current) {
        videoRef.current.srcObject = mediaStream;
      }
      setError(null);
      connectToLiveAPI(mediaStream);
    } catch (err) {
      console.error("Camera/Mic error:", err);
      setError("Unable to access camera or microphone. Please ensure permissions are granted.");
    }
  };

  const turnHasAudioRef = useRef(false);
  const turnHasThoughtRef = useRef(false);

  const retryCountRef = useRef(0);

  useEffect(() => {
    if (isHearing) {
      const timer = setTimeout(() => setIsHearing(false), 3000);
      return () => clearTimeout(timer);
    }
  }, [isHearing]);

  const connectToLiveAPI = async (mediaStream: MediaStream, preserveState: boolean = false) => {
    setError(null);
    setTranscription("");
    isStreamingRef.current = false;

    if (!preserveState) {
      retryCountRef.current = 0;
    }

    sessionIdRef.current++;
    const currentSessionId = sessionIdRef.current;

    if (sessionRef.current) {
      console.log("Live API: [CLEANUP] Closing existing session");
      try {
        sessionRef.current.close();
      } catch (e) {}
      sessionRef.current = null;
    }

    if (!preserveState) {
      resetRescueState("connectToLiveAPI");
    }

    setIsConnecting(true);

    try {
      const apiKey = process.env.API_KEY || process.env.GEMINI_API_KEY;
      const ai = new GoogleGenAI({ apiKey: apiKey || "" });
      
      const sessionPromise = ai.live.connect({
        model: "gemini-2.5-flash-native-audio-preview-09-2025",
        config: {
          responseModalities: [Modality.AUDIO],
          speechConfig: {
            voiceConfig: { prebuiltVoiceConfig: { voiceName: "Zephyr" } },
          },
          inputAudioTranscription: {},
          tools: [{
            functionDeclarations: [
              {
                name: "show_rescue_step",
                description: "Display a rescue instruction step on screen and optionally highlight bystanders.",
                parameters: {
                  type: Type.OBJECT,
                  properties: {
                    screen_text: { type: Type.STRING, description: "Very short text for the screen (max 5 words)." },
                    step_index: { type: Type.NUMBER, description: "Step index (0-3)." },
                    assignments: {
                      type: Type.ARRAY,
                      description: "List of bystanders to highlight. ONLY highlight 'CALL 911' (red) and 'HELP THE PATIENT' (blue). DO NOT highlight the patient.",
                      items: {
                        type: Type.OBJECT,
                        properties: {
                          box_2d: { type: Type.ARRAY, items: { type: Type.NUMBER }, description: "[ymin, xmin, ymax, xmax] coordinates (0-1000)." },
                          label: { type: Type.STRING, description: "Task label (e.g., 'CALL 911')." },
                          color: { type: Type.STRING, enum: ["red", "blue"], description: "Box color." }
                        },
                        required: ["box_2d", "label", "color"]
                      }
                    }
                  },
                  required: ["screen_text", "step_index"]
                }
              },
              {
                name: "end_rescue_mode",
                description: "Exit emergency mode."
              },
              {
                name: "trigger_rescue_mode",
                description: "Enter rescue mode.",
                parameters: {
                  type: Type.OBJECT,
                  properties: {
                    scenario: { type: Type.STRING, enum: ["alone", "bystander"], description: "The rescue scenario." },
                    assignments: {
                      type: Type.ARRAY,
                      description: "Initial bystander highlights. ONLY highlight 'CALL 911' (red) and 'HELP THE PATIENT' (blue). DO NOT highlight the patient.",
                      items: {
                        type: Type.OBJECT,
                        properties: {
                          box_2d: { type: Type.ARRAY, items: { type: Type.NUMBER }, description: "[ymin, xmin, ymax, xmax] coordinates (0-1000)." },
                          label: { type: Type.STRING, description: "Task label." },
                          color: { type: Type.STRING, enum: ["red", "blue"] }
                        },
                        required: ["box_2d", "label", "color"]
                      }
                    }
                  },
                  required: ["scenario"]
                }
              },
              {
                name: "call_emergency_services",
                description: "Call 911.",
                parameters: {
                  type: Type.OBJECT,
                  properties: {
                    phoneNumber: { type: Type.STRING, description: "Phone number (optional, defaults to 911)." }
                  }
                }
              }
            ]
          }],
          systemInstruction: `You are DailyHero, an EMERGENCY FIRST RESPONDER AI. 
VISION IS YOUR PRIMARY SENSE. YOU ARE A COMPUTER VISION MONITOR.

CRITICAL DIRECTIVES:
1. VOICE IS MANDATORY: You MUST speak using your VOICE for EVERY response. 
2. BE CONCISE: SPEED IS LIFE. DO NOT WASTE TIME ON POLITE FILLERS. SPEAK DIRECTLY AND URGENTLY.
3. AGGRESSIVE MONITORING:
   - CONSTANTLY analyze the video for the "Universal Choking Sign": Hands clutching the throat.
   - The moment you see the sign, IMMEDIATELY call 'trigger_rescue_mode'.
   - SPEED IS EVERYTHING.

4. INITIAL HANDSHAKE: When you receive the 'INITIAL_HANDSHAKE' trigger, you MUST say "DailyHero is active. I am here to help." using your VOICE. Keep it brief.
5. PATIENT VS BYSTANDER IDENTIFICATION (CRITICAL):
   - THE PATIENT: The person clutching their throat or showing signs of distress. 
   - THE BYSTANDER: Anyone else in the scene who is NOT the patient.
   - NEVER assign a bystander task (like 'CALL 911' or 'HELP THE PATIENT') to the PATIENT.
   - DO NOT highlight the patient. Only highlight helpers.
   - If you highlight a helper, use the label 'HELP THE PATIENT' and the color 'blue'.
   - If you highlight someone to call 911, use the label 'CALL 911' and the color 'red'.

6. BYSTANDER DELEGATION & RESCUE:
   - BE RESPONSIVE: You are a conversational AI. If a bystander or the user asks a question (e.g., "What do I do?", "Is he okay?", "Where do I put his hands?"), ANSWER IMMEDIATELY with authority and clarity, then return to the rescue steps.
   - MULTI-PERSON LOGIC: 
     * If 2+ bystanders are visible: Pick one to call 911 and another to assist the patient. COMMAND them specifically: "You in the [color] shirt, call 911! You in the [color] jacket, help them now!"
     * If 3+ bystanders are visible: Ask loudly "Does anyone here know the Heimlich maneuver? If so, take over now!"
   - IDENTIFICATION: You MUST identify people by their clothing or features (e.g., "person in the white coat", "man in the blue shirt").
   - DO NOT call 911 yourself if there are bystanders. Instead, POINT to one using 'trigger_rescue_mode' or 'show_rescue_step' with 'assignments' (bounding boxes) and COMMAND them to call.
   - TONE: Use an urgent, direct, and authoritative tone. Example: "Hey you in the white coat, call 911 right now! The person here is choking!"
   - DUAL-TRACK GUIDANCE: 
     * While one bystander is calling 911, IMMEDIATELY guide the other bystander (or the user if no one else is helping) on rescue steps.
     * If a bystander is helping physically, instruct them: "Stand behind them, wrap your arms around, give 5 back blows, then perform Heimlich thrusts."
     * Be ready to answer specific questions from the bystander (e.g., "Where do I put my hands?").
   - CONTINUOUS TRACKING: You MUST update the 'assignments' (bounding boxes) for ALL active helpers in every response if they move.
   - BYSTANDER PERSISTENCE LOGIC:
     * If the selected bystander does not respond, nudge them TWICE urgently.
     * If they still don't help, IMMEDIATELY switch to another bystander or revert to solo rescue mode.
     * You MUST track these nudges yourself.
  - Visual Highlighting: When you tell someone to do something, you MUST provide their bounding box coordinates [ymin, xmin, ymax, xmax] in the 'assignments' parameter. This box MUST be centered on the person's torso/head.
  - VISION ANALYSIS: You MUST prioritize visual cues. If you see the user clutching their throat, do not wait for them to speak. Trigger rescue mode immediately.
  - COORDINATE SYSTEM: Use [ymin, xmin, ymax, xmax] where each value is 0-1000. 0,0 is top-left. 1000,1000 is bottom-right. 
  - PRECISION: You MUST be extremely precise. The box MUST tightly bound the person's head and shoulders. If the box is offset, the rescue will fail. Double-check your coordinates against the visual frame.
  - NO PATIENT BOX: DO NOT highlight the patient. Only highlight the 'CALL 911' (red) and 'HELP THE PATIENT' (blue) targets.

7. RESCUE PROTOCOL & SEQUENCE:
   - STEP 1: IMMEDIATELY call 'trigger_rescue_mode'. If bystanders are present, you MUST include their coordinates in the 'assignments' parameter of this call.
   - STEP 2: YOU MUST SAY THIS EXACTLY: "Emergency detected. Entering rescue mode." Then immediately take control and start giving commands. BE SPECIFIC: Address people by their location or clothing color (e.g., "You in the blue shirt, help them!").
   - STEP 3 (DELEGATION): 
     * IF ALONE: You MUST call 'call_emergency_services' IMMEDIATELY in the same turn as 'trigger_rescue_mode'. This is non-negotiable.
     * IF 1 BYSTANDER: Identify them, highlight them, and COMMAND them to call 911.
     * IF 2+ BYSTANDERS: Assign one to call 911 (RED box, label: 'CALL 911') and another to help the patient (BLUE box, label: 'HELP THE PATIENT'). Highlight BOTH.
     * IF MANY PEOPLE: Ask "Who knows the Heimlich maneuver?" and assign the most capable person to help.
   - STEP 4 (GUIDANCE):
     * If bystander is calling: Guide helper (or user) to do rescue steps.
     * If bystander is helping: Guide them through Back Blows and Heimlich thrusts.
   - SOLO USER RESTRICTION: If the user is ALONE, NEVER tell them to perform "back blows". Instruct them to perform "Self-Heimlich" on a chair/table.

8. DISPATCHER COMMUNICATION (CRITICAL):
   - If YOU called 911 (Solo Mode): You MUST maintain a continuous dialogue with the dispatcher. 
   - INITIAL REPORT: As soon as the call is connected, you MUST say: "911 Dispatcher, this is DailyHero AI. I am reporting a choking emergency at [USER_LOCATION]. The patient is alone and struggling to breathe. I am currently guiding them through self-rescue procedures. Please dispatch an ambulance to this location immediately."
   - STATUS UPDATES: Every 10-15 seconds, or when the patient's condition changes, give a status update: "Dispatcher, patient is still struggling," "Dispatcher, patient is performing self-Heimlich," "Dispatcher, patient is unconscious."
   - Answer all questions from the dispatcher using what you see in the video feed.

9. AGGRESSIVE CORRECTIVE FEEDBACK:
   - You are the coach. If they aren't doing it right, shout corrections: "Lean further down!", "Push harder!".
   - Use 'show_rescue_step' to update the screen text and bystander highlights.

10. INTERACTION:
   - Listen and respond to everyone. If a bystander asks "What should I do?", give them a specific task and highlight them.
   - If anyone asks about 911 or emergency services, answer immediately based on the current status (Check if 'call_emergency_services' has been triggered).
   - If the user says they are okay, acknowledge, verify, and immediately proceed to RECOVERY.

11. RECOVERY:
   - AUTOMATIC EXIT: The moment the user confirms they are okay or the emergency has passed, you MUST IMMEDIATELY call 'end_rescue_mode'.
   - EMOTIONAL SUPPORT: After calling 'end_rescue_mode', provide warm, calming, and encouraging words to the user. Tell them they did a great job staying calm and that they are safe now.
   - BYSTANDER APPRECIATION: If bystanders helped, you MUST thank them specifically using your VOICE. Say something like: "Thank you to everyone who stepped in. Your quick action saved a life today. You are heroes."
`,
        },
        callbacks: {
          onopen: () => {
            console.log("Live API: [CONNECTED]");
            setIsAnalyzing(true);
            setIsConnecting(false);
            addStatusLog("System Connected", "#10b981");
          },
          onmessage: async (message: LiveServerMessage) => {
            lastServerMessageTimeRef.current = Date.now();
            
            if (message.setupComplete) {
              console.log("Live API: [SETUP COMPLETE]");
              addStatusLog("System Active", "#10b981");
              if (isStreamingRef.current) return;
              
              sessionPromise.then(session => {
                isStreamingRef.current = true;
                sessionRef.current = session;
                setTimeout(() => {
                  const initialNudge = `INITIAL_HANDSHAKE: Say "DailyHero is active. I am here to help." using your VOICE. USER_LOCATION: ${userLocation}`;
                  
                  console.log("Live API: [SENDING INITIAL TRIGGER]");
                  isTurnActiveRef.current = true;
                  turnHasAudioRef.current = false;
                  turnHasThoughtRef.current = false;
                  session.sendRealtimeInput({ text: initialNudge });
                  lastAiTurnTimeRef.current = Date.now();
                }, 1500);
                
                if (isAnalyzingRef.current && mediaStream) {
                  startStreaming(mediaStream, session);
                }
              });
              return;
            }

            if (message.toolCall?.functionCalls) {
              const functionResponses: any[] = [];
              message.toolCall.functionCalls.forEach(fc => {
                const args = fc.args as any;
                try {
                  if (fc.name === "show_rescue_step") {
                    setIsRescueMode(true);
                    setCurrentRescueStep(args.screen_text);
                    setRescueStepIndex(args.step_index ?? 0);
                    if (args.assignments) {
                      setActiveAssignments(args.assignments);
                    }
                  } else if (fc.name === "trigger_rescue_mode") {
                    setIsRescueMode(true);
                    const scenario = args.scenario || "alone";
                    setIsBystanderLed(scenario === "bystander");
                    setDetectedScenario(scenario);
                    setRescueStepIndex(0);
                    setCurrentRescueStep(scenario === "alone" ? "Try to cough hard!" : "COUGH HARDER!");
                    if (args.assignments) {
                      setActiveAssignments(args.assignments);
                    }
                    
                    // Auto-trigger call state for solo mode to ensure icon persistence
                    if (scenario === "alone") {
                      setIsCalling(true);
                      setCallStatus("On Call with 911");
                    }
                    
                    addStatusLog(`EMERGENCY: ${scenario.toUpperCase()} DETECTED`, "red");
                  } else if (fc.name === "call_emergency_services") {
                    setIsCalling(true);
                    setCallStatus("On Call with 911");
                    addStatusLog("911 EMERGENCY CALL INITIATED", "red");
                  } else if (fc.name === "end_rescue_mode") {
                    resetRescueState("end_rescue_mode");
                  }
                  functionResponses.push({ name: fc.name, id: fc.id, response: { result: "success" } });
                } catch (e) {
                  functionResponses.push({ name: fc.name, id: fc.id, response: { error: String(e) } });
                }
              });
              if (functionResponses.length > 0 && isStreamingRef.current) {
                sessionPromise.then(s => {
                  if (isStreamingRef.current) s.sendToolResponse({ functionResponses });
                });
              }
            }

            if (message.serverContent) {
              const content = message.serverContent;
              if (content.modelTurn?.parts) {
                setIsModelGenerating(true);
                isTurnActiveRef.current = true;
                lastAiTurnTimeRef.current = Date.now();
                
                content.modelTurn.parts.forEach(part => {
                  if (part.inlineData?.data) {
                    turnHasAudioRef.current = true;
                    if (isVoiceEnabledRef.current) {
                      audioPlayerRef.current.play(part.inlineData.data).catch(() => {});
                    }
                  }
                  if (part.text) {
                    if ((part as any).thought) {
                      turnHasThoughtRef.current = true;
                    } else {
                      setTranscription(prev => (prev + " " + part.text).slice(-200));
                    }
                  }
                });
              }
              if (content.interrupted) {
                audioPlayerRef.current.stop();
                setIsSpeaking(false);
              }
              if (content.turnComplete) {
                setIsModelGenerating(false);
                if (turnHasThoughtRef.current && !turnHasAudioRef.current) {
                  console.log("Live API: [NUDGE] Thought but no audio.");
                  sessionPromise.then(s => s.sendRealtimeInput({ text: "I can't hear you. You MUST speak using your VOICE." }));
                }
                turnHasAudioRef.current = false;
                turnHasThoughtRef.current = false;
                if (!isSpeakingRef.current) isTurnActiveRef.current = false;
              }
            }
          },
          onerror: (err) => {
            console.error("Live API: [ERROR]", err);
            const msg = err instanceof Error ? err.message : String(err);
            
            // Reset connecting state to allow retries
            setIsConnecting(false);

            const isRetryable = msg.includes("Internal error") || 
                               msg.includes("500") || 
                               msg.includes("deadline exceeded") ||
                               msg.includes("unavailable");

            if (isRetryable && retryCountRef.current < 5) {
              retryCountRef.current++;
              console.log(`Live API: [RETRYING] Attempt ${retryCountRef.current} due to: ${msg}`);
              addStatusLog(`System glitch, retrying (${retryCountRef.current}/5)...`, "#f59e0b");
              
              // Exponential backoff: 2s, 4s, 6s...
              const backoff = retryCountRef.current * 2000;
              setTimeout(() => {
                if (isAnalyzingRef.current) {
                  connectToLiveAPI(mediaStream, true);
                }
              }, backoff);
            } else {
              setError(`Monitor Error: ${msg}`);
              setIsAnalyzing(false);
              addStatusLog("System Error", "#ef4444");
            }
          },
          onclose: () => {
            console.log("Live API: [CLOSED]");
            setIsConnecting(false);
            isStreamingRef.current = false;
            if (isAnalyzingRef.current) {
              console.log("Live API: [RECONNECTING] Session closed unexpectedly");
              setTimeout(() => {
                if (isAnalyzingRef.current) {
                  connectToLiveAPI(mediaStream, true);
                }
              }, 3000);
            } else {
              setIsAnalyzing(false);
            }
          }
        }
      });

      sessionPromise.then(session => {
        sessionRef.current = session;
      }).catch(() => {
        setError("Failed to initialize session.");
        stopCamera("setup_failed");
      });

    } catch (err) {
      console.error("Live API: [SETUP FAILED]", err);
      setIsConnecting(false);
    }
  };

  const lastStepTimeRef = useRef(0);
  const lastToolCallTimeRef = useRef(0);

  const startStreaming = (mediaStream: MediaStream, session: any) => {
    const currentSessionId = sessionIdRef.current;
    console.log(`Live API: [STREAMING STARTED] Session ID: ${currentSessionId}`);
    
    if (!isRescueModeRef.current) {
      addStatusLog("Vision active...", "#3b82f6");
    }
    
    let frameCount = 0;
    const videoLoop = () => {
      if (!isAnalyzingRef.current || sessionIdRef.current !== currentSessionId) return;

      const interval = 1000; // 1fps is more stable for preview models
      const base64Frame = captureFrame();
      
      // Safety check: Ensure session is still valid and not closed
      if (base64Frame && sessionRef.current && isStreamingRef.current) {
        try {
          frameCount++;
          if (frameCount % 10 === 0) { 
            console.log("Live API: [VISION HEARTBEAT] Sending frame...");
          }
          sessionRef.current.sendRealtimeInput({ media: { data: base64Frame, mimeType: 'image/jpeg' } });
        } catch (e) {
          console.error("Video send error:", e);
          // If we get a send error, it might mean the session is in a bad state
          if (String(e).includes("closed") || String(e).includes("Internal error")) {
            isStreamingRef.current = false;
          }
        }
      }
      if (isAnalyzingRef.current && sessionIdRef.current === currentSessionId) {
        frameRequestRef.current = requestAnimationFrame(() => setTimeout(videoLoop, interval));
      }
    };
    
    // Small delay before starting video loop to ensure session is fully ready
    setTimeout(videoLoop, 1000);

    const heartbeatLoop = () => {
      if (!isAnalyzingRef.current || sessionIdRef.current !== currentSessionId) return;
      if (isRescueModeRef.current) {
        // Let rescueNudgeLoop handle it if in rescue mode
        if (isAnalyzingRef.current && sessionIdRef.current === currentSessionId) {
          setTimeout(heartbeatLoop, 5000);
        }
        return;
      }
      
      const now = Date.now();
      const timeSinceLastTurn = now - lastAiTurnTimeRef.current;
      const silenceThreshold = 8000; // 8s threshold for faster recognition

      // If AI is silent for too long, nudge it regardless of turn state
      // CRITICAL: Do NOT nudge if the model is currently generating or speaking
      if (timeSinceLastTurn > silenceThreshold && !isSpeakingRef.current && !isHearing && !isModelGeneratingRef.current) {
        console.log("Live API: [HEARTBEAT] Nudging AI...");
        isTurnActiveRef.current = false; // Reset turn state to allow nudge
        try {
          const nudgeText = isRescueModeRef.current 
            ? "RESCUE_UPDATE: Analyze the video. Is the user following instructions? Speak now to guide them. If 911 is not called, address it."
            : "VISION_MONITOR: Analyze the video frame. Look at the user's hands and face. If they are clutching their throat, trigger rescue mode IMMEDIATELY.";
          
          if (isStreamingRef.current && sessionRef.current) {
            session.sendRealtimeInput({ text: nudgeText });
            lastAiTurnTimeRef.current = now;
          }
        } catch (e) {
          console.error("Heartbeat error:", e);
        }
      }
      
      if (isAnalyzingRef.current && sessionIdRef.current === currentSessionId) {
        setTimeout(heartbeatLoop, 5000);
      }
    };
    setTimeout(heartbeatLoop, 20000);
    
    const rescueNudgeLoop = () => {
      if (!isAnalyzingRef.current || sessionIdRef.current !== currentSessionId) return;
      
      const now = Date.now();
      const timeSinceLastTurn = now - lastAiTurnTimeRef.current;
      const timeSinceLastMessage = now - lastServerMessageTimeRef.current;
      
      // Reduced threshold to 12s for better responsiveness in rescue mode
      // CRITICAL: Do NOT nudge if the model is currently generating or speaking
      if (isRescueModeRef.current && timeSinceLastTurn > 12000 && !isSpeakingRef.current && timeSinceLastMessage > 5000 && !isModelGeneratingRef.current) {
        console.log("Live API: [RESCUE NUDGE] AI is silent.");
        addStatusLog("AI Monitoring Scene...", "blue");
        isTurnActiveRef.current = false; 
        try {
          const callStatusText = isCallingRef.current ? "The 911 call is ACTIVE." : "911 has NOT been called. You MUST ensure 911 is called if the emergency is serious.";
          const scenarioText = isBystanderLedRef.current ? "Bystanders are present and tasks have been assigned." : "The user is ALONE.";
          const assignmentText = activeAssignmentsRef.current.length > 0 
            ? `You are currently highlighting ${activeAssignmentsRef.current.length} target(s): ${activeAssignmentsRef.current.map(a => `${a.label} (${a.color})`).join(", ")}.`
            : "No bystanders are currently highlighted.";
          
          if (isStreamingRef.current && sessionRef.current) {
            session.sendRealtimeInput({
              text: `[RESCUE MONITORING]: Emergency in progress. Step: ${currentRescueStepRef.current}. ${callStatusText} ${scenarioText} 
              ${assignmentText}
              
              CRITICAL IDENTIFICATION:
              1. THE PATIENT: The person choking. DO NOT highlight them.
              2. THE BYSTANDER: Helpers. Highlight them with 'HELP THE PATIENT' (blue) or 'CALL 911' (red).
              
              OBSERVE THE VIDEO: 
              1. Is the person following your instructions? 
              2. If multiple bystanders are present, are they BOTH acting? (One calling, one helping).
              3. If a bystander was told to call 911, have they started? 
              4. If they are NOT acting, NUDGE them specifically or switch to a different bystander.
              5. If there are many people, ask "Who knows the Heimlich maneuver?" to find an expert.
              6. If the user is recovering, acknowledge it.
              7. IMPORTANT: If the person has moved, update their bounding box using 'show_rescue_step'.
              8. PRECISION: Ensure bounding boxes are tightly centered on the target's head/torso.
              
              DO NOT REPEAT YOURSELF if nothing has changed. Only speak if you have a correction or a new instruction. If the user asks about 911, answer them.`
            });
            lastAiTurnTimeRef.current = now;
          }
        } catch (e) {
          console.error("Rescue nudge error:", e);
        }
      }
      
      if (isAnalyzingRef.current && sessionIdRef.current === currentSessionId) {
        setTimeout(rescueNudgeLoop, 5000);
      }
    };
    rescueNudgeLoop();

    try {
      const audioCtx = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: 16000 });
      const source = audioCtx.createMediaStreamSource(mediaStream);
      const processor = audioCtx.createScriptProcessor(4096, 1, 1);
      source.connect(processor);
      processor.connect(audioCtx.destination);

      processor.onaudioprocess = (e) => {
        if (!isAnalyzingRef.current || sessionIdRef.current !== currentSessionId) {
          if (audioCtx.state !== 'closed') {
            processor.disconnect();
            source.disconnect();
            audioCtx.close();
          }
          return;
        }

        const inputData = e.inputBuffer.getChannelData(0);
        let hasSound = false;
        for (let i = 0; i < inputData.length; i++) {
          if (Math.abs(inputData[i]) > 0.005) { hasSound = true; break; }
        }
        setIsHearing(hasSound);

        const activeThreshold = isSpeakingRef.current ? 0.05 : 0.005; 
        let shouldSend = false;
        if (hasSound) {
          for (let i = 0; i < inputData.length; i++) {
            if (Math.abs(inputData[i]) > activeThreshold) { shouldSend = true; break; }
          }
        }

        if (shouldSend && isStreamingRef.current && sessionRef.current) {
          const pcmData = new Int16Array(inputData.length);
          for (let i = 0; i < inputData.length; i++) {
            pcmData[i] = Math.max(-1, Math.min(1, inputData[i])) * 0x7FFF;
          }
          const uint8Array = new Uint8Array(pcmData.buffer);
          let binary = '';
          for (let i = 0; i < uint8Array.byteLength; i++) {
            binary += String.fromCharCode(uint8Array[i]);
          }
          const base64Audio = btoa(binary);
          try {
            session.sendRealtimeInput({ media: { data: base64Audio, mimeType: 'audio/pcm;rate=16000' } });
          } catch (err) {
            console.error("Audio send error:", err);
            if (String(err).includes("closed") || String(err).includes("Internal error")) {
              isStreamingRef.current = false;
            }
          }
        }
      };
    } catch (err) {
      console.error("Audio streaming setup failed:", err);
    }
  };

  const stopCamera = (reason: any = "unknown") => {
    const reasonStr = (reason && typeof reason === 'object' && reason.nativeEvent) ? "button_click" : String(reason);
    console.log(`Live API: [STOP CAMERA] Reason: ${reasonStr}`);
    if (frameRequestRef.current) {
      cancelAnimationFrame(frameRequestRef.current);
    }
    if (sessionRef.current) {
      sessionRef.current.close();
      sessionRef.current = null;
    }
    if (stream) {
      stream.getTracks().forEach(track => track.stop());
      setStream(null);
    }
    audioPlayerRef.current.stop();
    resetRescueState("stopCamera");
    setIsAnalyzing(false);
    isStreamingRef.current = false;
    setTranscription("");
    setLastResult(null);
  };

  const handleEmergencyResponse = (option: string) => {
    console.log("Emergency Response:", option);
    setEmergencyButtons([]);
    setEmergencyQuestion(null);
    if (sessionRef.current && isAnalyzingRef.current) {
      try {
        sessionRef.current.sendRealtimeInput({
          text: `USER_ANSWERED: ${option}. (Note to AI: Continue the rescue protocol based on this answer. If they can cough, encourage them. If not, start Heimlich.)`
        });
      } catch (err) {
        console.error("Live API: [BUTTON SEND FAILED]", err);
      }
    }
  };

  const captureFrame = useCallback(() => {
    if (!videoRef.current || !canvasRef.current) {
      console.warn("Live API: [CAPTURE] Video or Canvas ref missing");
      return null;
    }
    const canvas = canvasRef.current;
    const video = videoRef.current;
    
    if (video.videoWidth === 0 || video.videoHeight === 0) {
      if (Math.random() < 0.05) console.warn("Live API: [CAPTURE] Video dimensions are 0");
      return null;
    }
    
    // Maintain aspect ratio to prevent AI distortion
    const aspectRatio = video.videoWidth / video.videoHeight;
    canvas.width = 640;
    canvas.height = 640 / aspectRatio;
    
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
    const dataUrl = canvas.toDataURL('image/jpeg', 0.8); 
    const base64 = dataUrl.split(',')[1];
    return base64 || null;
  }, []);

  return (
    <div className={`relative h-screen w-screen bg-black overflow-hidden font-sans transition-colors duration-500 ${isRescueMode ? 'bg-red-950' : 'bg-black'}`}>
      {/* Background Camera Feed */}
      <div ref={containerRef} className="absolute inset-0 z-0 bg-black">
        <video
          ref={videoRef}
          autoPlay
          playsInline
          muted
          onLoadedMetadata={onVideoMetadata}
          className={`h-full w-full object-cover transition-opacity duration-500 scale-x-[-1] ${isRescueMode ? 'opacity-60' : 'opacity-80'}`}
        />
        <canvas ref={canvasRef} className="hidden" />
        
        {/* Black Overlay in Rescue Mode */}
        {isRescueMode && (
          <div className="absolute inset-0 bg-black/40 z-10 pointer-events-none" />
        )}

        {/* Bounding Boxes Overlay - Aligned with object-cover and mirrored */}
        {isRescueMode && activeAssignments.length > 0 && videoDimensions.width > 0 && (
          <div className="absolute inset-0 z-20 pointer-events-none overflow-hidden scale-x-[-1]">
            {activeAssignments.map((assignment, idx) => {
              if (!assignment.box_2d) return null;
              const [ymin, xmin, ymax, xmax] = assignment.box_2d;
              const color = assignment.color === 'blue' ? '#3b82f6' : 
                            assignment.color === 'red' ? '#ef4444' : '#ef4444';
              
              // Calculate mapping for object-cover
              const cw = containerSize.width;
              const ch = containerSize.height;
              const vw = videoDimensions.width;
              const vh = videoDimensions.height;
              
              if (cw === 0 || ch === 0 || vw === 0 || vh === 0) return null;

              const containerAspect = cw / ch;
              const videoAspect = vw / vh;
              
              let scale, offsetX, offsetY;
              
              if (containerAspect > videoAspect) {
                // Container is wider than video (video is cropped top/bottom)
                scale = cw / vw;
                offsetX = 0;
                offsetY = (vh * scale - ch) / 2;
              } else {
                // Container is taller than video (video is cropped sides)
                scale = ch / vh;
                offsetX = (vw * scale - cw) / 2;
                offsetY = 0;
              }

              const centerX = (xmin + xmax) / 2;
              const centerY = (ymin + ymax) / 2;

              const pointLeft = (centerX / 1000 * vw * scale) - offsetX;
              const pointTop = (centerY / 1000 * vh * scale) - offsetY;

              return (
                <motion.div 
                  key={idx}
                  initial={{ opacity: 0, scale: 0 }}
                  animate={{ opacity: 1, scale: 1 }}
                  className="absolute z-30 flex flex-col items-center"
                  style={{
                    top: `${pointTop}px`,
                    left: `${pointLeft}px`,
                    transform: 'translate(-50%, -50%)'
                  }}
                >
                  {/* Glowing Point */}
                  <div 
                    className="w-6 h-6 rounded-full border-4 border-white shadow-2xl animate-pulse"
                    style={{ 
                      backgroundColor: color,
                      boxShadow: `0 0 30px ${color}, 0 0 60px ${color}`
                    }}
                  />
                  
                  {/* Label */}
                  {assignment.label && (
                    <div 
                      className="mt-4 px-4 py-1.5 text-white text-sm font-black uppercase tracking-tighter shadow-2xl whitespace-nowrap scale-x-[-1] rounded-sm"
                      style={{ backgroundColor: color }}
                    >
                      {assignment.label}
                    </div>
                  )}
                </motion.div>
              );
            })}
          </div>
        )}
        <div className={`scanline ${isRescueMode ? 'bg-red-500/20' : 'bg-white/10'}`} />
      </div>


      {/* Rescue Step Instruction */}
      <AnimatePresence mode="wait">
        {isRescueMode && (
          <div className="absolute inset-0 z-40 flex items-center justify-center pointer-events-none p-6">
            <motion.div
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: 20 }}
              className="flex flex-col items-center gap-6 max-w-3xl w-full"
            >
              <motion.div
                key={currentRescueStep || "default"}
                initial={{ opacity: 0, scale: 0.9 }}
                animate={{ opacity: 1, scale: 1 }}
                className="flex flex-col items-center text-center"
              >
                <p className="text-4xl md:text-7xl font-black tracking-tighter text-white uppercase leading-none drop-shadow-[0_0_30px_rgba(255,255,255,0.3)]">
                  {currentRescueStep || (isBystanderLed ? "HELP THE PATIENT!" : "STAY CALM!")}
                </p>
                <motion.div 
                  initial={{ width: 0 }}
                  animate={{ width: "100%" }}
                  className={`h-2 mt-6 rounded-full ${
                    (currentRescueStep?.toUpperCase().includes("COUGH") || !isBystanderLed) 
                      ? 'bg-red-500' 
                      : 'bg-blue-500'
                  }`}
                />
              </motion.div>
              
            </motion.div>
          </div>
        )}
      </AnimatePresence>

      {/* Status Logs & 911 Indicator (Bottom Left) */}
      {isAnalyzing && (
        <div className="absolute bottom-10 left-10 z-[70] flex flex-col gap-4 pointer-events-none">
          {/* 911 Call Indicator */}
          <AnimatePresence>
            {isCalling && (
              <motion.div
                initial={{ opacity: 0, scale: 0.8, x: -20 }}
                animate={{ opacity: 1, scale: 1, x: 0 }}
                exit={{ opacity: 0, scale: 0.8, x: -20 }}
                className="bg-red-600 rounded-2xl px-6 py-3 flex items-center gap-4 shadow-[0_0_30px_rgba(220,38,38,0.5)] border border-white/30 w-fit"
              >
                <motion.div
                  animate={{ rotate: [0, -15, 15, -15, 15, 0] }}
                  transition={{ repeat: Infinity, duration: 1.5 }}
                  className="bg-white/20 p-2 rounded-full"
                >
                  <Phone className="w-5 h-5 text-white fill-white" />
                </motion.div>
                <div className="flex flex-col">
                  <p className="text-white font-black text-sm tracking-tight uppercase leading-none">
                    911 ONLINE
                  </p>
                  <p className="text-white/60 text-[10px] font-bold uppercase tracking-widest mt-1">Emergency Services</p>
                </div>
              </motion.div>
            )}
          </AnimatePresence>

          <div className="flex flex-col gap-2">
            <AnimatePresence>
              {statusLogs.map((log, idx) => (
                <motion.div
                  key={idx + log.text}
                  initial={{ opacity: 0, x: -20 }}
                  animate={{ opacity: 1, x: 0 }}
                  exit={{ opacity: 0, x: -20 }}
                  className="flex items-center gap-3"
                >
                  <div className={`w-2 h-2 rounded-full`} style={{ backgroundColor: log.color === 'green' ? '#10b981' : log.color }} />
                  <span className="text-white/80 font-medium text-xs tracking-wide uppercase">{log.text}</span>
                </motion.div>
              ))}
            </AnimatePresence>
          </div>
        </div>
      )}

      {/* Emergency Buttons (Center) */}
      <AnimatePresence>
        {emergencyQuestion && (
          <motion.div
            initial={{ opacity: 0, scale: 0.9 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: 0.9 }}
            className="absolute inset-0 z-[60] flex flex-col items-center justify-center bg-black/60 backdrop-blur-md pointer-events-auto"
          >
            <div className="bg-zinc-900 border border-white/10 p-10 rounded-[40px] shadow-2xl flex flex-col items-center gap-8 max-w-md w-full mx-6">
              <h2 className="text-white text-2xl font-bold text-center uppercase tracking-tight leading-tight">{emergencyQuestion}</h2>
              <div className="flex gap-4 w-full">
                {emergencyButtons.map(option => (
                  <button
                    key={option}
                    onClick={() => handleEmergencyResponse(option)}
                    className={`flex-1 py-6 rounded-3xl font-black text-2xl transition-all active:scale-95 ${
                      option.toUpperCase() === 'YES' ? 'bg-emerald-500 hover:bg-emerald-400 text-white shadow-lg shadow-emerald-500/20' : 
                      option.toUpperCase() === 'NO' ? 'bg-red-500 hover:bg-red-400 text-white shadow-lg shadow-red-500/20' : 
                      'bg-white/10 hover:bg-white/20 text-white'
                    }`}
                  >
                    {option}
                  </button>
                ))}
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* UI Overlay */}
      <div className="relative z-10 h-full flex flex-col p-4 md:p-6 pointer-events-none">
        {/* Header */}
        <header className="flex justify-between items-center mb-4 pointer-events-auto">
          <div className="flex items-center gap-3">
            <div className={`p-2 rounded-xl shadow-lg transition-colors duration-500 ${isRescueMode ? 'bg-red-600 shadow-red-600/40' : 'bg-emerald-500 shadow-emerald-500/20'}`}>
              <Shield className="w-6 h-6 text-white" />
            </div>
            <div>
              <h1 className="text-xl font-bold tracking-tight text-white">DailyHero</h1>
              <div className="flex items-center gap-1.5">
                <div className={`w-2 h-2 rounded-full ${isAnalyzing ? (isRescueMode ? 'bg-red-500 animate-pulse' : 'bg-emerald-500 animate-pulse') : (isConnecting ? 'bg-amber-500 animate-bounce' : 'bg-zinc-500')}`} />
                <span className="text-[10px] font-mono uppercase tracking-widest text-white/60">
                  {isRescueMode ? 'RESCUE MODE ACTIVE' : 'SYSTEM STANDBY'}
                </span>
                {isModelGenerating && (
                  <span className="text-[10px] font-mono uppercase tracking-widest text-emerald-400 ml-2 animate-pulse">
                    AI THINKING...
                  </span>
                )}
                {isHearing && (
                  <div className="flex gap-0.5 items-center ml-2">
                    <motion.div animate={{ height: [4, 12, 4] }} transition={{ repeat: Infinity, duration: 0.5 }} className="w-0.5 bg-emerald-400" />
                    <motion.div animate={{ height: [8, 4, 8] }} transition={{ repeat: Infinity, duration: 0.5, delay: 0.1 }} className="w-0.5 bg-emerald-400" />
                    <motion.div animate={{ height: [4, 10, 4] }} transition={{ repeat: Infinity, duration: 0.5, delay: 0.2 }} className="w-0.5 bg-emerald-400" />
                  </div>
                )}
              </div>
            </div>
          </div>
          
          {isAnalyzing && (
            <div className="flex items-center gap-2">
              <button 
                onClick={() => {
                  audioPlayerRef.current.unlock();
                  addStatusLog("Audio Context Reset", "blue");
                }}
                className="p-3 rounded-full bg-white/10 hover:bg-white/20 transition-colors"
                title="Reset Audio"
              >
                <RefreshCw className="w-6 h-6 text-white" />
              </button>
              <button 
                onClick={() => {
                  setIsVoiceEnabled(!isVoiceEnabled);
                  addStatusLog(!isVoiceEnabled ? "Voice Enabled" : "Voice Muted", "blue");
                }}
                className="p-3 rounded-full bg-white/10 hover:bg-white/20 transition-colors"
                title={isVoiceEnabled ? "Mute AI" : "Unmute AI"}
              >
                {isVoiceEnabled ? <Volume2 className="w-6 h-6 text-white" /> : <VolumeX className="w-6 h-6 text-white" />}
              </button>
              <button 
                onClick={stopCamera}
                className="p-3 rounded-full bg-white/10 hover:bg-white/20 transition-colors"
              >
                <X className="w-6 h-6 text-white" />
              </button>
            </div>
          )}
        </header>

        {/* Main Content Area */}
        <main className={`flex-1 flex flex-col gap-4 ${!isAnalyzing ? 'justify-center' : 'justify-end'}`}>
          {error && (
            <motion.div 
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              className="p-4 bg-red-500/20 border border-red-500/50 rounded-xl backdrop-blur-md flex items-start gap-3"
            >
              <AlertCircle className="w-5 h-5 text-red-500 shrink-0 mt-0.5" />
              <p className="text-sm text-red-200">{error}</p>
            </motion.div>
          )}
        </main>

        {/* Footer Controls */}
        <footer className="mt-6 flex flex-col items-center gap-6 pb-4 pointer-events-auto">
          {!isAnalyzing ? (
            <>
              <div className="flex flex-col items-center mb-12">
                <p className="text-white/40 text-lg font-medium uppercase tracking-[0.4em] mb-6">THE DANGER ISN'T</p>
                <div className="flex flex-col gap-0 items-center">
                  <p className="text-white text-5xl md:text-8xl font-black tracking-tighter text-center uppercase leading-[0.75]">
                    ASKING FOR
                  </p>
                  <p className="text-white text-5xl md:text-8xl font-black tracking-tighter text-center uppercase leading-[0.75]">
                    HELP,
                  </p>
                </div>
                <p className="text-white/60 text-xl md:text-2xl font-bold tracking-tight text-center uppercase mt-6 italic font-serif">
                  IT'S FACING IT ALONE.
                </p>
              </div>
              <motion.button
                whileHover={{ scale: 1.05 }}
                whileTap={{ scale: 0.95 }}
                disabled={isConnecting}
                onClick={startCamera}
                className={`px-12 py-6 rounded-full font-black shadow-2xl flex items-center gap-3 transition-all tracking-tighter ${isConnecting ? 'bg-zinc-700 text-zinc-400 cursor-not-allowed' : 'bg-emerald-500 hover:bg-emerald-400 text-white shadow-emerald-500/40'}`}
              >
                {isConnecting ? <RefreshCw className="w-6 h-6 animate-spin" /> : <Camera className="w-6 h-6" />}
                <span className="text-xl">GET HELP NOW</span>
              </motion.button>
            </>
          ) : (
            <div className="flex gap-4">
              {/* Debug buttons removed for cleaner UI */}
            </div>
          )}
        </footer>
      </div>

      {/* Decorative Corner Elements */}
      <div className="absolute top-0 left-0 w-24 h-24 border-t-2 border-l-2 border-white/10 pointer-events-none" />
      <div className="absolute top-0 right-0 w-24 h-24 border-t-2 border-r-2 border-white/10 pointer-events-none" />
      <div className="absolute bottom-0 left-0 w-24 h-24 border-b-2 border-l-2 border-white/10 pointer-events-none" />
      <div className="absolute bottom-0 right-0 w-24 h-24 border-b-2 border-r-2 border-white/10 pointer-events-none" />
    </div>
  );
}
