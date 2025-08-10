import React, { useState, useEffect, useRef } from 'react';
import { useParams, useNavigate, useSearchParams } from 'react-router-dom';
import { motion, AnimatePresence } from 'framer-motion';
import { useDebateStore } from '../../stores/debateStore';
import type { DebateArgument } from '../../stores/debateStore';
import { useAuthStore } from '../../stores/authStore';
import { geminiService } from '../../services/ai/gemini';
import { judgeWithGroq } from '../../services/ai/deepseek';
import { Card } from '../ui/Card';
import Button from '../ui/Button';
import { Input } from '../ui/Input';
import { Modal } from '../ui/Modal';
import { Badge } from '../ui/Badge';
import { Progress } from '../ui/Progress';
import { Toast } from '../ui/Toast';
import { LoadingSpinner } from '../animations/LoadingSpinner';
import { TypingIndicator } from '../animations/TypingIndicator';
import { ConfettiAnimation } from '../animations/ConfettiAnimation';
import { onSnapshot, doc, updateDoc, deleteDoc, increment, getDoc, runTransaction } from 'firebase/firestore';
import { firestore } from '../../lib/firebase';
import { 
  Zap, 
  Clock, 
  Target, 
  Trophy, 
  Brain, 
  MessageSquare, 
  Send as SendIcon, 
  X, 
  Crown,
  Flame,
  Star,
  Award,
  TrendingUp,
  Mic,
  Flag,
  Sun,
  Moon,
  RotateCcw
} from 'lucide-react';
// Remove: import { Client } from "@gradio/client";

interface DebateRoomProps {
  debateId?: string;
}

export const DebateRoom: React.FC<DebateRoomProps> = ({ debateId: propDebateId }) => {
  const { debateId: urlDebateId } = useParams<{ debateId: string }>();
  const debateId = propDebateId || urlDebateId;
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const isPracticeMode = searchParams.get('mode') === 'practice';
  
  const { user: currentUser, refreshUserData } = useAuthStore();
  const {
    currentDebate,
    isLoading,
    error,
    getDebateById,
    submitArgument,
    updateParticipantStatus,
    endDebate,
    simulateTyping,
    simulatePresence
  } = useDebateStore();

  const [argument, setArgument] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [showJudgment, setShowJudgment] = useState(false);
  const [coachingTip, setCoachingTip] = useState('');
  const [showCoaching, setShowCoaching] = useState(false);
  const [timeRemaining, setTimeRemaining] = useState(0);
  const [isMyTurn, setIsMyTurn] = useState(false);
  const [showWinner, setShowWinner] = useState(false);
  const [lastAIGeneratedArgumentId, setLastAIGeneratedArgumentId] = useState<string | null>(null);
  const [isAITyping, setIsAITyping] = useState(false);
  const [optimisticArguments, setOptimisticArguments] = useState<DebateArgument[]>([]);
  const [pendingArguments, setPendingArguments] = useState<DebateArgument[]>([]);
  // Add local state for submitted arguments
  const [localSubmittedArguments, setLocalSubmittedArguments] = useState<DebateArgument[]>([]);
  const [isJudging, setIsJudging] = useState(false);
  const [selectedJudge, setSelectedJudge] = useState<'gemini' | 'llama' | 'gemma'>('gemini');
  const [hasHandledRoundsComplete, setHasHandledRoundsComplete] = useState(false);
  
  const argumentInputRef = useRef<HTMLTextAreaElement>(null);
  const debateContainerRef = useRef<HTMLDivElement>(null);
  const [inputHeight, setInputHeight] = useState(64); // px, default height for textarea
  const dragHandleRef = useRef<HTMLDivElement>(null);
  const draggingRef = useRef(false);
  const lastYRef = useRef(0);

  // Add state for voice input (Hugging Face Whisper 2-step fetch)
  const [isRecording, setIsRecording] = useState(false);
  const [isTranscribing, setIsTranscribing] = useState(false); // Kept for UI compatibility
  const [voiceError, setVoiceError] = useState<string | null>(null);
  const recognitionRef = useRef<any>(null);

  // Add browser detection for Brave and Firefox
  const [isBraveOrFirefox, setIsBraveOrFirefox] = useState(false);

  // Practice mode timeout state
  const [practiceTimeLeft, setPracticeTimeLeft] = useState<number | null>(null);
  const [practiceTimeoutId, setPracticeTimeoutId] = useState<NodeJS.Timeout | null>(null);
  const [practiceSettings, setPracticeSettings] = useState<any>(null);
  const [currentRound, setCurrentRound] = useState(1);
  const [userArgumentsInRound, setUserArgumentsInRound] = useState(0);
  const [aiArgumentsInRound, setAiArgumentsInRound] = useState(0);
  const [hasEndedDueToRounds, setHasEndedDueToRounds] = useState(false);
  const [hasEndedDueToTimeout, setHasEndedDueToTimeout] = useState(false);
  // Add a local state to prevent double endDebate
  const [hasSubmittedEnd, setHasSubmittedEnd] = useState(false);

  // Helper: Convert Blob to base64 (if needed)
  const blobToBase64 = (blob: Blob): Promise<string> => {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onloadend = () => {
        if (typeof reader.result === 'string') {
          resolve(reader.result.split(',')[1]); // Remove data:...;base64,
        } else {
          reject('Failed to convert blob to base64');
        }
      };
      reader.onerror = reject;
      reader.readAsDataURL(blob);
    });
  };

  // Debug logging
  useEffect(() => {
    console.log('DebateRoom: debateId param:', debateId);
    console.log('DebateRoom: currentDebate:', currentDebate);
  }, [debateId, currentDebate]);

  // Real-time debate listener
  useEffect(() => {
    if (!debateId) return;

    const unsubscribe = onSnapshot(
      doc(firestore, 'debates', debateId),
      (docSnap) => {
        if (docSnap.exists()) {
          const debateData = { id: docSnap.id, ...docSnap.data() } as any;
          // Update local state with real-time data
          console.log('[DEBUG] Firestore onSnapshot: new arguments:', debateData.arguments, 'status:', debateData.status, 'currentTurn:', debateData.currentTurn);
          // Update the Zustand store's currentDebate
          useDebateStore.setState({ currentDebate: debateData });
          if (debateData.status === 'completed' && debateData.judgment) {
            setShowJudgment(true);
            setShowWinner(true);
          }
        }
      },
      (error) => {
        console.error('Debate listener error:', error);
      }
    );

    return () => unsubscribe();
  }, [debateId]);

  // Load debate data
  useEffect(() => {
    if (debateId) {
      getDebateById(debateId);
    }
  }, [debateId, getDebateById]);

  // Update presence
  useEffect(() => {
    if (debateId && currentUser) {
      simulatePresence(debateId, currentUser.uid, true);
      
      return () => {
        simulatePresence(debateId, currentUser.uid, false);
      };
    }
  }, [debateId, currentUser, simulatePresence]);

  // Check if it's user's turn
  useEffect(() => {
    if (currentDebate && currentUser) {
      const isTurn = currentDebate.currentTurn === currentUser.uid;
      setIsMyTurn(isTurn);
      
      if (isTurn && argumentInputRef.current) {
        argumentInputRef.current.focus();
      }
    }
  }, [currentDebate, currentUser]);

  // Timer countdown
  useEffect(() => {
    if (!currentDebate || currentDebate.status !== 'active') return;

    const interval = setInterval(() => {
      setTimeRemaining(prev => {
        if (prev <= 0) {
          // Time's up - auto-submit or end turn
          return 0;
        }
        return prev - 1;
      });
    }, 1000);

    return () => clearInterval(interval);
  }, [currentDebate]);

  // Auto-scroll to latest argument
  useEffect(() => {
    if (debateContainerRef.current) {
      debateContainerRef.current.scrollTop = debateContainerRef.current.scrollHeight;
    }
  }, [currentDebate?.arguments]);

  // Drag logic for input box resizing
  useEffect(() => {
    const onMouseMove = (e: MouseEvent) => {
      if (!draggingRef.current) return;
      const delta = e.clientY - lastYRef.current;
      setInputHeight(prev => Math.max(48, Math.min(240, prev + delta * -1)));
      lastYRef.current = e.clientY;
    };
    const onMouseUp = () => {
      draggingRef.current = false;
      document.body.style.cursor = '';
    };
    if (draggingRef.current) {
      window.addEventListener('mousemove', onMouseMove);
      window.addEventListener('mouseup', onMouseUp);
      document.body.style.cursor = 'ns-resize';
    }
    return () => {
      window.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('mouseup', onMouseUp);
      document.body.style.cursor = '';
    };
  }, [draggingRef.current]);

  // Practice mode timeout and round tracking
  useEffect(() => {
    if (!currentDebate || !isPracticeMode) return;
    
    // Load practice settings from debate data
    if ((currentDebate as any).practiceSettings && !practiceSettings) {
      setPracticeSettings((currentDebate as any).practiceSettings);
    }
  }, [currentDebate, isPracticeMode, practiceSettings]);

  // Practice mode timeout countdown
  useEffect(() => {
    if (!isPracticeMode || !practiceSettings || !isMyTurn || practiceTimeLeft === null) return;
    
    // Disable timer if debate is completed
    if (currentDebate?.status === 'completed') {
      setPracticeTimeLeft(null);
      if (practiceTimeoutId) {
        clearTimeout(practiceTimeoutId);
        setPracticeTimeoutId(null);
      }
      return;
    }

    if (practiceTimeLeft <= 0) {
      // Time's up - auto-end debate with AI judgment (same as End Debate button)
      handleEndDebate();
      return;
    }

    const timeoutId = setTimeout(() => {
      setPracticeTimeLeft(prev => prev !== null ? prev - 1 : null);
    }, 1000);

    setPracticeTimeoutId(timeoutId);

    return () => {
      if (timeoutId) clearTimeout(timeoutId);
    };
  }, [practiceTimeLeft, isPracticeMode, practiceSettings, isMyTurn, currentDebate?.status]);

  // Start timeout when it's user's turn in practice mode
  useEffect(() => {
    if (!isPracticeMode || !practiceSettings || !isMyTurn) return;
    
    // Start timeout countdown
    const timeoutSeconds = practiceSettings.timeoutSeconds || 300;
    setPracticeTimeLeft(timeoutSeconds); // Already in seconds
  }, [isMyTurn, isPracticeMode, practiceSettings]);

  // Track rounds and end debate when complete
  useEffect(() => {
    if (!isPracticeMode || !practiceSettings || !currentDebate || !currentUser) return;

    // Calculate current round based on number of arguments
    // Each round = 1 user argument + 1 AI argument
    const totalArgs = currentDebate.arguments?.length || 0;
    const completedRounds = Math.floor(totalArgs / 2);
    const currentRound = Math.min(completedRounds + 1, practiceSettings.numberOfRounds);
    
    setCurrentRound(currentRound);

    // End debate if we've completed all rounds (both user and AI have gone)
    const allRoundsCompleted = completedRounds >= practiceSettings.numberOfRounds;
    
    if (allRoundsCompleted && !hasHandledRoundsComplete) {
      console.log(`[DEBUG] All rounds completed. Total arguments: ${totalArgs}, Rounds: ${completedRounds}/${practiceSettings.numberOfRounds}`);
      setHasHandledRoundsComplete(true);
      handleRoundsComplete();
    }
  }, [currentDebate, isPracticeMode, practiceSettings, currentUser, hasHandledRoundsComplete]);

  // Handle timeout end
  const handleTimeoutEnd = async () => {
    if (!currentDebate || !currentUser || !currentDebate.id) return;
    
    try {
      // Create a timeout judgment
      const timeoutJudgment = {
        winner: 'timeout',
        scores: {},
        feedback: {},
        reasoning: 'Debate ended due to timeout',
        fallaciesDetected: [],
        highlights: []
      };
      await endDebate(currentDebate.id, timeoutJudgment);
      alert('Time\'s up! The debate has ended.');
    } catch (error) {
      console.error('Failed to end debate on timeout:', error);
    }
  };

  // Handle rounds complete
  const handleRoundsComplete = async () => {
    if (!currentDebate || !currentUser || !currentDebate.id) return;
    
    try {
      // Rounds completed - auto-end debate with AI judgment (same as End Debate button)
      handleEndDebate();
    } catch (error) {
      console.error('Failed to end debate on rounds complete:', error);
    }
  };

  // Get coaching tip
  const getCoachingTip = async () => {
    if (!currentDebate || !currentUser) return;

    const myStance = currentDebate.participants.find(p => p.userId === currentUser.uid)?.stance;
    const opponentArguments = currentDebate.arguments
      .filter(arg => arg.userId !== currentUser.uid)
      .slice(-3)
      .map(arg => arg.content);

    try {
      const tip = await geminiService.getCoachingTip(
        currentDebate.topic,
        myStance || 'pro',
        currentDebate.currentRound,
        opponentArguments
      );
      setCoachingTip(tip);
      setShowCoaching(true);
    } catch (error) {
      console.error('Failed to get coaching tip:', error);
    }
  };

  // Handle argument submission
  const handleSubmitArgument = async () => {
    if (!debateId || !currentUser || !argument.trim() || isSubmitting) return;

    setIsSubmitting(true);
    try {
      // Local instant UI: add the argument to pendingArguments
      const localArg: DebateArgument = {
        id: `local_${Date.now()}`,
        userId: currentUser.uid,
        content: argument.trim(),
        timestamp: Date.now(),
        round: currentDebate?.currentRound || 1,
        wordCount: argument.trim().split(' ').length
      };
      setPendingArguments(prev => [...prev, localArg]);
      setArgument('');
      // Add to localSubmittedArguments immediately
      setLocalSubmittedArguments(prev => [...prev, localArg]);
      // Update Firebase in background
      await submitArgument(debateId, currentUser.uid, argument.trim());
      // Get AI feedback for the argument
      const myStance = currentDebate?.participants.find(p => p.userId === currentUser.uid)?.stance;
      if (myStance) {
        const analysis = await geminiService.analyzeArgument(
          argument.trim(),
          currentDebate?.topic || '',
          myStance,
          currentDebate?.currentRound || 1
        );
        // Store AI feedback (you might want to save this to Firebase)
        console.log('[DEBUG] AI Analysis:', analysis);
      }
    } catch (error) {
      console.error('[DEBUG] Failed to submit argument:', error);
    } finally {
      setIsSubmitting(false);
    }
  };



  // New AI response function that takes the transcript
  const generateAIResponseWithTranscript = async (transcript: string) => {
    if (!currentDebate || !debateId || !practiceSettings) {
      console.log('[DEBUG] generateAIResponseWithTranscript: missing currentDebate or debateId or practiceSettings');
      return;
    }
    try {
      console.log('[DEBUG] generateAIResponseWithTranscript called');
      const aiPersonality = currentDebate.aiPersonality || 'Balanced and analytical';
      // Always get AI stance from participants array
      const aiStance = aiParticipant?.stance || 'pro';
      let aiResponse = '';
      if (practiceSettings.aiProvider === 'gemini') {
        aiResponse = await geminiService.generateAIResponse(
          currentDebate.topic,
          aiStance,
          aiPersonality,
          transcript,
          currentDebate.currentRound
        );
      } else if (practiceSettings.aiProvider === 'llama' || practiceSettings.aiProvider === 'gemma') {
        // Compose a prompt that includes the AI's stance
        let prompt;
        if (transcript.trim() === '') {
          // No transcript provided - make the first argument
          prompt = `You are debating as the ${aiStance.toUpperCase()} side. Topic: ${currentDebate.topic}\n\nStart the debate with a strong opening argument as the ${aiStance.toUpperCase()} side.`;
        } else {
          // Respond to existing transcript
          prompt = `You are debating as the ${aiStance.toUpperCase()} side. Topic: ${currentDebate.topic}\nTranscript so far:\n${transcript}\nRespond as the ${aiStance.toUpperCase()} side.`;
        }
        const model = practiceSettings.aiProvider === 'llama' ? 'llama-3.3-70b-versatile' : 'gemma2-9b-it';
        aiResponse = await judgeWithGroq(prompt, model);
      }
      console.log('[DEBUG] AI generated response (with transcript):', aiResponse);
      await submitArgument(debateId, 'ai_opponent', aiResponse);
      console.log('[DEBUG] AI argument submitted to Firestore (with transcript)');
    } catch (error) {
      console.error('[DEBUG] Failed to generate AI response (with transcript):', error);
    }
  };

  // Get judge selection from practice settings
  useEffect(() => {
    if (isPracticeMode && currentDebate?.practiceSettings?.aiProvider) {
      setSelectedJudge(currentDebate.practiceSettings.aiProvider);
    }
  }, [isPracticeMode, currentDebate?.practiceSettings?.aiProvider]);

  // useEffect to trigger AI response in practice mode when it's AI's turn
  useEffect(() => {
    if (
      isPracticeMode &&
      currentDebate?.isPractice &&
      currentDebate.currentTurn === 'ai_opponent' &&
      currentDebate.status === 'active' &&
      !isAITyping
    ) {
      const lastArg = currentDebate.arguments[currentDebate.arguments.length - 1];
      
      // Case 1: AI should respond to user's argument
      if (lastArg && lastArg.userId !== 'ai_opponent') {
        // Only respond if we haven't already processed this argument
        if (lastAIGeneratedArgumentId !== lastArg.id) {
          console.log(`[DEBUG] AI turn detected - responding to user's argument in round ${currentDebate.currentRound}`);
          setLastAIGeneratedArgumentId(lastArg.id);
          setIsAITyping(true);
          
          // Prepare the full transcript for Gemini
          const transcript = currentDebate.arguments.map(arg => {
            const participant = currentDebate.participants.find(p => p.userId === arg.userId);
            return `${participant?.displayName || arg.userId} (${participant?.stance?.toUpperCase() || ''}): ${arg.content}`;
          }).join('\n');
          
          console.log('[DEBUG] AI transcript for Gemini:', transcript);
          generateAIResponseWithTranscript(transcript)
            .catch(error => console.error('[DEBUG] Error generating AI response:', error))
            .finally(() => {
              console.log('[DEBUG] AI response generation completed');
              setIsAITyping(false);
            });
        }
      }
      // Case 2: AI should start the debate (no arguments yet)
      else if (currentDebate.arguments.length === 0 && !lastAIGeneratedArgumentId) {
        console.log('[DEBUG] AI starting the debate - no arguments yet');
        setIsAITyping(true);
        // Generate opening argument for AI
        generateAIResponseWithTranscript('')
          .catch(error => console.error('[DEBUG] Error generating AI opening:', error))
          .finally(() => {
            console.log('[DEBUG] AI opening generation completed');
            setIsAITyping(false);
          });
      }
    }
  }, [currentDebate?.arguments, isPracticeMode, currentDebate?.currentTurn, currentDebate?.status, lastAIGeneratedArgumentId, isAITyping]);

  const buildJudgmentPrompt = () => {
    // Build the same JSON-format prompt as for Gemini, but explicit for Deepseek
    const topic = currentDebate?.topic || '';
    const participants = currentDebate?.participants || [];
    const debateArguments = currentDebate?.arguments || [];
    return `You are an expert debate judge. Given the following debate, return ONLY a valid JSON object with these fields:\n{\n  "winner": "<userId of winner>",\n  "scores": {\n    "<userId1>": <score, float, 1 decimal>,\n    "<userId2>": <score, float, 1 decimal>\n  },\n  "feedback": {\n    "<userId1>": ["<feedback1>", ...],\n    "<userId2>": ["<feedback1>", ...]\n  },\n  "reasoning": "<reasoning>",\n  "highlights": ["<highlight1>", ...],\n  "learningPoints": ["<point1>", ...]\n}\nDo NOT include any explanation or text outside the JSON. All scores must be floats with one decimal. Always pick a winner.\nDebate data:\nTOPIC: ${topic}\nPARTICIPANTS: ${participants.map(p => `- ${p.displayName} (${p.stance.toUpperCase()})`).join(' ')}\nARGUMENTS: ${debateArguments.map(arg => `ROUND ${arg.round} - ${participants.find(p => p.userId === arg.userId)?.displayName}: \"${arg.content}\"`).join(' ')}\n`;
  };

  // Handle debate end
  const handleEndDebate = async () => {
    if (!currentDebate || !debateId || !practiceSettings) return;
    if (currentDebate.status === 'completed' || hasSubmittedEnd) return;
    setHasSubmittedEnd(true);
    setIsJudging(true);
    try 
    {
      let judgment: any;
      if (currentDebate.arguments.length === 0) {
        const participantIds = currentDebate.participants.map(p => p.userId);
        const scores = participantIds.reduce((acc, userId) => {
          acc[userId] = 0;
          return acc;
        }, {} as { [key: string]: number });

        judgment = {
          winner: '',
          reasoning: 'The debate concluded with no arguments from either side, resulting in a draw.',
          scores: scores,
          learningPoints: [],
          highlights: []
        };

      } 
      else 
      {
        if (practiceSettings.aiProvider === 'gemini') {
          judgment = await geminiService.judgeDebate(
            currentDebate.topic,
            currentDebate.arguments.map(arg => ({
              id: arg.id,
              userId: arg.userId,
              content: arg.content,
              stance: currentDebate.participants.find(p => p.userId === arg.userId)?.stance || 'pro',
              round: arg.round
            })),
            currentDebate.participants.map(p => ({
              userId: p.userId,
              displayName: p.displayName,
              stance: p.stance
            }))
          );
        } 
        else if (practiceSettings.aiProvider === 'llama' || practiceSettings.aiProvider === 'gemma') 
        {
          const prompt = buildJudgmentPrompt();
          const model = practiceSettings.aiProvider === 'llama' ? 'llama-3.3-70b-versatile' : 'gemma2-9b-it';
          const response = await judgeWithGroq(prompt, model);
          if (!response) throw new Error('No response from Groq');
          const jsonMatch = response.match(/\{[\s\S]*\}/);
          if (!jsonMatch) throw new Error('Invalid response from Groq');
          judgment = JSON.parse(jsonMatch[0]);
        }
      }
      
      console.log('[DEBUG] Submitting judgment to Firestore:', judgment);
      await endDebate(debateId, judgment); // Only Firestore update triggers UI
      await updateDoc(doc(firestore, 'debates', debateId), {
        mode: isPracticeMode ? 'practice' : 'live',
        endedBy: currentUser?.uid || ''
      });
      console.log('[DEBUG] AI judgment saved to Firestore:', judgment);}
    
    catch (error) {
      console.error('[DEBUG] Failed to end debate:', error);
    } finally {
      setIsJudging(false);
    }
  };

  // Handle typing indicator
  const handleTyping = (isTyping: boolean) => {
    if (debateId && currentUser) {
      simulateTyping(debateId, currentUser.uid, isTyping);
    }
  };

  // Exit Debate and Judge with Gemini
  const [showJudgmentModal, setShowJudgmentModal] = useState(false);
  const [judgmentResult, setJudgmentResult] = useState<any>(null);
  const handleExitDebate = async () => {
    if (!currentDebate || !debateId) return;
    if (currentDebate.status === 'completed') return;
    try {
      console.log('[DEBUG] Exiting debate and requesting AI judgment:', debateId);
      // Prepare transcript for judging
      const transcript = currentDebate.arguments.map(arg => {
        const participant = currentDebate.participants.find(p => p.userId === arg.userId);
        return {
          id: arg.id,
          userId: arg.userId,
          content: arg.content,
          stance: participant?.stance || 'pro',
          round: arg.round
        };
      });
      const participants = currentDebate.participants.map(p => ({
        userId: p.userId,
        displayName: p.displayName,
        stance: p.stance
      }));
      // Call Gemini judgeDebate
      const aiJudgment = await geminiService.judgeDebate(
        currentDebate.topic,
        transcript,
        participants
      );
      setJudgmentResult(aiJudgment);
      setShowJudgmentModal(true);
      // Save result to Firestore
      await endDebate(debateId, aiJudgment);
      await updateDoc(doc(firestore, 'debates', debateId), {
        mode: isPracticeMode ? 'practice' : 'live',
        endedBy: currentUser?.uid || ''
      });
      console.log('[DEBUG] AI judgment saved to Firestore:', aiJudgment);
    } catch (error) {
      console.error('[DEBUG] Failed to exit and judge debate:', error);
    }
  };

  // Remove pending argument when backend version appears (but do NOT remove from localSubmittedArguments)
  useEffect(() => {
    if (!currentDebate) return;
    setPendingArguments(prev => prev.filter(localArg => {
      return !currentDebate.arguments.some(realArg =>
        realArg.userId === localArg.userId &&
        realArg.content === localArg.content &&
        realArg.round === localArg.round
      );
    }));
  }, [currentDebate?.arguments]);

  // Start recording (MediaRecorder)
  useEffect(() => {
    const ua = navigator.userAgent.toLowerCase();
    const isFirefox = ua.includes('firefox');
    // Brave detection: navigator.brave is defined, or check for Brave-specific properties
    const isBrave = (navigator as any).brave && typeof (navigator as any).brave.isBrave === 'function';
    setIsBraveOrFirefox(isFirefox || isBrave);
  }, []);

  // Web Speech API: Start recording
  const handleStartRecording = () => {
    setVoiceError(null);
    setIsTranscribing(false);
    if (!('webkitSpeechRecognition' in window) && !('SpeechRecognition' in window)) {
      setVoiceError('Web Speech API is not supported in this browser.');
      return;
    }
    const SpeechRecognition = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    if (!SpeechRecognition) {
      setVoiceError('Web Speech API is not available.');
      return;
    }
    const recognition = new SpeechRecognition();
    recognitionRef.current = recognition;
    recognition.continuous = true;  // Keep recording during pauses
    recognition.interimResults = true;  // Show partial results
    recognition.lang = 'en-US';
    setIsRecording(true);
    
    let finalTranscript = '';
    
    recognition.onresult = (event: any) => {
      let interimTranscript = '';
      
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const transcript = event.results[i][0].transcript;
        if (event.results[i].isFinal) {
          finalTranscript += transcript + ' ';
        } else {
          interimTranscript += transcript;
        }
      }
      
      // Update the argument field with final transcript only
      if (finalTranscript) {
        setArgument((prev) => prev + (prev ? ' ' : '') + finalTranscript.trim());
        finalTranscript = '';
      }
    };
    
    recognition.onerror = (event: any) => {
      // Only show error and stop if it's a real error, not just no-speech
      if (event.error !== 'no-speech') {
        setVoiceError('Speech recognition error: ' + event.error);
        setIsRecording(false);
      }
    };
    
    recognition.onend = () => {
      // Only stop if we're not supposed to be recording anymore
      // This prevents auto-restart when continuous mode ends
      if (isRecording) {
        setIsRecording(false);
      }
    };
    
    try {
      recognition.start();
    } catch (err: any) {
      setVoiceError('Could not start speech recognition: ' + (err.message || err));
      setIsRecording(false);
    }
  };

  // Web Speech API: Stop recording
  const handleStopRecording = () => {
    if (recognitionRef.current && isRecording) {
      try {
        recognitionRef.current.stop();
      } catch (err) {
        // ignore
      }
      setIsRecording(false);
    }
  };

  // After currentDebate is loaded, check if it has zero arguments and delete if so
  const [deleted, setDeleted] = useState(false);
  const [deleteCountdown, setDeleteCountdown] = useState<number | null>(null);
  const deleteTimeoutRef = useRef<NodeJS.Timeout | null>(null);

  // Start countdown if debate has zero arguments
  useEffect(() => {
    if (
      currentDebate &&
      Array.isArray(currentDebate.arguments) &&
      currentDebate.arguments.length === 0 &&
      currentDebate.id
    ) {
      setDeleteCountdown(60); // 60 seconds countdown
      if (deleteTimeoutRef.current) clearTimeout(deleteTimeoutRef.current);
      // Start interval to update countdown
      const interval = setInterval(() => {
        setDeleteCountdown(prev => {
          if (prev === null) return null;
          if (prev <= 1) {
            clearInterval(interval);
            return 0;
          }
          return prev - 1;
        });
      }, 1000);
      // Set timeout to delete debate after 60 seconds
      deleteTimeoutRef.current = setTimeout(() => {
        const debateRef = doc(firestore, 'debates', currentDebate.id);
        deleteDoc(debateRef).then(() => {
          setDeleted(true);
          navigate('/find-debate');
        });
      }, 60000);
      return () => {
        clearInterval(interval);
        if (deleteTimeoutRef.current) clearTimeout(deleteTimeoutRef.current);
      };
    } else {
      setDeleteCountdown(null);
      if (deleteTimeoutRef.current) clearTimeout(deleteTimeoutRef.current);
    }
  }, [currentDebate, navigate]);

  // Cancel timer if an argument is submitted
  useEffect(() => {
    if (
      currentDebate &&
      Array.isArray(currentDebate.arguments) &&
      currentDebate.arguments.length > 0
    ) {
      setDeleteCountdown(null);
      if (deleteTimeoutRef.current) clearTimeout(deleteTimeoutRef.current);
    }
  }, [currentDebate]);

  // Reset flag when debate or arguments reset
  useEffect(() => {
    setHasHandledRoundsComplete(false);
  }, [debateId]);

  const [isDarkMode, setIsDarkMode] = useState(() => document.documentElement.classList.contains('dark'));

  if (deleted) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-black text-white">
        <div className="text-center">
          <div className="text-lg font-semibold mb-2">This debate has been deleted.</div>
        </div>
      </div>
    );
  }

  // --- NEW LAYOUT START ---
  // Force black background
  if (!debateId) {
    return (
      <div className="min-h-screen bg-black flex items-center justify-center text-white">
        <div className="text-center">
          <div className="text-3xl font-bold mb-4">No Debate ID Provided</div>
          <div className="mb-2">Please check the URL or start a new debate.</div>
          </div>
      </div>
    );
  }
  if (isLoading && !currentDebate) {
    return (
      <div className="min-h-screen bg-black flex items-center justify-center text-white">
        <div className="text-center">
          <div className="text-2xl font-bold mb-4">Loading Debate...</div>
          <LoadingSpinner size="lg" />
        </div>
      </div>
    );
  }
  if (!currentDebate) {
    // Get debate title from store if available
    const debateTitle = useDebateStore.getState().currentDebate?.topic || 'Loading...';
    const toggleTheme = () => {
      const newDarkMode = !isDarkMode;
      setIsDarkMode(newDarkMode);
      document.documentElement.classList.toggle('dark');
    };
    return (
      <>
        <div className="flex flex-col items-center justify-center flex-1 w-full min-h-screen bg-black text-white">
          <div className="mb-6 mt-24">
            {/* Animated SVG Chat Bubble Loader */}
            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 320 200" width="320" height="200">
              <defs>
                <clipPath id="bubbleClip">
                  <path d="M20 40 Q20 20 40 20 H280 Q300 20 300 40 V120 Q300 140 280 140 H100 L70 170 L80 140 H40 Q20 140 20 120 Z"/>
                </clipPath>
              </defs>
              <path d="M20 40 Q20 20 40 20 H280 Q300 20 300 40 V120 Q300 140 280 140 H100 L70 170 L80 140 H40 Q20 140 20 120 Z"
                fill="none" 
                stroke="#d1d5db" 
                strokeWidth="4.5"/>
              <path d="M20 40 Q20 20 40 20 H280 Q300 20 300 40 V120 Q300 140 280 140 H100 L70 170 L80 140 H40 Q20 140 20 120 Z"
                fill="none" 
                stroke="#00d4ff" 
                strokeWidth="3"
                strokeLinecap="round"
                strokeDasharray="10 20"
                opacity="0.8">
                <animate attributeName="stroke-dashoffset" dur="1.5s" values="0;-30;0" repeatCount="indefinite"/>
                <animate attributeName="opacity" values="0.4;1;0.4" dur="1.5s" repeatCount="indefinite"/>
              </path>
              <path d="M20 40 Q20 20 40 20 H280 Q300 20 300 40 V120 Q300 140 280 140 H100 L70 170 L80 140 H40 Q20 140 20 120 Z"
                fill="none" 
                stroke="#0099cc" 
                strokeWidth="1"
                strokeLinecap="round"
                strokeDasharray="5 25"
                opacity="0.6">
                <animate attributeName="stroke-dashoffset" dur="1.5s" values="0;-30;0" repeatCount="indefinite" begin="0.3s"/>
                <animate attributeName="opacity" values="0.2;0.8;0.2" dur="1.5s" repeatCount="indefinite" begin="0.3s"/>
              </path>
              <g clipPath="url(#bubbleClip)">
                <path fill="none" 
                  stroke="#3b82f6" 
                  strokeWidth="8" 
                  strokeLinecap="round"
                  strokeDasharray="200 250" 
                  strokeDashoffset="0"
                  d="M235 80c0 20-18 32-32 32-38 0-60-65-98-65-18 0-32 14-32 32s15 32 32 32c38 0 60-65 98-65 16 0 32 12 32 32Z">
                  <animate attributeName="stroke-dashoffset" calcMode="spline" dur="2s" values="450;-450" keySplines="0 0 1 1" repeatCount="indefinite"/>
                </path>
              </g>
            </svg>
          </div>
          <div className="text-2xl font-bold mt-2">Loading Debate...</div>
        </div>
        {/* Always show header at the top */}
        <div className="w-full flex items-center justify-between px-6 py-4 bg-black/80 border-b border-gray-800" style={{position: 'sticky', top: 0, left: 0, zIndex: 50}}>
          <div className="text-xl font-bold truncate max-w-[70vw]" title={debateTitle}>{debateTitle}</div>
          <button
            onClick={toggleTheme}
            className={`p-2 rounded-lg transition-colors duration-200 ${isDarkMode ? 'text-white' : 'text-gray-900'} hover:bg-gray-100 dark:hover:bg-gray-700`}
            title="Toggle light/dark mode"
          >
            {isDarkMode ? <Sun className="w-5 h-5" /> : <Moon className="w-5 h-5" />}
          </button>
        </div>
      </>
    );
  }

  // In chat rendering, always get stance from participants array
  const myParticipant = currentDebate.participants.find(p => p.userId === currentUser?.uid);
  const aiParticipant = currentDebate.participants.find(p => p.userId === 'ai_opponent');
  const canSubmit = isMyTurn && argument.trim().length > 0 && !isSubmitting;
  const isDebateActive = currentDebate.status === 'active';
  const isDebateCompleted = currentDebate.status === 'completed';

  // Find the latest message from the current user in local state
  const latestLocalArg = [...pendingArguments, ...localSubmittedArguments]
    .filter(arg => arg.userId === currentUser?.uid)
    .sort((a, b) => b.timestamp - a.timestamp)[0];

  // All previous messages from Firebase, excluding the latest from the current user
  const firebaseMessages = currentDebate.arguments
    .filter(arg => !(arg.userId === currentUser?.uid && latestLocalArg && arg.content === latestLocalArg.content && arg.round === latestLocalArg.round))
    .sort((a, b) => a.timestamp - b.timestamp);

  // Compose chat arguments: merge firebaseMessages and latestLocalArg, then sort by timestamp so the latest local user message appears in correct order
  const chatArguments = latestLocalArg
    ? [...firebaseMessages, latestLocalArg].sort((a, b) => a.timestamp - b.timestamp)
    : firebaseMessages;

  const chatArgumentsWithDisplayRound = chatArguments.map((arg, index) => ({
    ...arg,
    displayRound: Math.floor(index / 2) + 1,
  }));

  // After all error/deleted/404 checks, but before rendering results:
  if (isDebateCompleted && !currentDebate.judgment) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-black text-white">
        <div className="flex flex-col items-center">
          <LoadingSpinner size="lg" />
          <div className="text-2xl font-bold mt-6">Evaluating your debate...</div>
        </div>
      </div>
    );
  }

  // --- MAIN RENDER LOGIC ---
  return (
    <div className="relative min-h-screen w-full flex flex-col bg-black text-white select-none" style={{background: '#000'}}>
      {/* Always show header at the top */}
      <div className="w-full flex items-center justify-between px-6 py-4 bg-black/80 border-b border-gray-800" style={{position: 'sticky', top: 0, left: 0, zIndex: 50}}>
        <div className="flex items-center gap-4">
          <div className="text-lg font-bold max-w-[70vw] leading-tight break-words" title={currentDebate?.topic || 'Loading...'}>{currentDebate?.topic || 'Loading...'}</div>
          {/* Practice Mode Timer */}
          {isPracticeMode && practiceTimeLeft !== null && isMyTurn && !isDebateCompleted && (
            <div className="flex items-center gap-2">
              <Clock className="w-4 h-4 text-gray-400" />
              <span className="text-sm font-medium">
                {Math.floor(practiceTimeLeft / 60)}:{(practiceTimeLeft % 60).toString().padStart(2, '0')}
              </span>
            </div>
          )}
          {/* Round Counter */}
          {isPracticeMode && practiceSettings && (
            <div className="flex items-center gap-2 text-sm text-gray-400">
              <RotateCcw className="w-4 h-4" />
              <span>Round {currentRound}/{practiceSettings.numberOfRounds}</span>
            </div>
          )}
        </div>
        <button
          onClick={() => {
            const newDarkMode = !isDarkMode;
            setIsDarkMode(newDarkMode);
            document.documentElement.classList.toggle('dark');
          }}
          className={`p-2 rounded-lg transition-colors duration-200 ${isDarkMode ? 'text-white' : 'text-gray-900'} hover:bg-gray-100 dark:hover:bg-gray-700`}
          title="Toggle light/dark mode"
        >
          {isDarkMode ? <Sun className="w-5 h-5" /> : <Moon className="w-5 h-5" />}
        </button>
      </div>
      
      {/* Practice Mode Visual Timer Bar */}
      {isPracticeMode && practiceTimeLeft !== null && isMyTurn && practiceSettings && !isDebateCompleted && (
        <div className="w-full h-1 bg-gray-800">
          <div 
            className="h-full transition-all duration-1000 ease-linear"
            style={{
              width: `${(practiceTimeLeft / practiceSettings.timeoutSeconds) * 100}%`,
              background: `linear-gradient(to right, 
                ${practiceTimeLeft / practiceSettings.timeoutSeconds > 0.6 ? '#166534' : 
                  practiceTimeLeft / practiceSettings.timeoutSeconds > 0.4 ? '#10b981' : 
                  practiceTimeLeft / practiceSettings.timeoutSeconds > 0.2 ? '#f59e0b' : 
                  practiceTimeLeft / practiceSettings.timeoutSeconds > 0.1 ? '#ef4444' : '#7f1d1d'})`
            }}
          />
        </div>
      )}
      
      {/* Content below header: loading or main debate UI */}
      {!currentDebate ? (
        <div className="flex flex-col items-center justify-center flex-1 w-full min-h-screen bg-black text-white">
          <div className="mb-6 mt-24">
            {/* Animated SVG Chat Bubble Loader */}
            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 320 200" width="320" height="200">
              <defs>
                <clipPath id="bubbleClip">
                  <path d="M20 40 Q20 20 40 20 H280 Q300 20 300 40 V120 Q300 140 280 140 H100 L70 170 L80 140 H40 Q20 140 20 120 Z"/>
                </clipPath>
              </defs>
              <path d="M20 40 Q20 20 40 20 H280 Q300 20 300 40 V120 Q300 140 280 140 H100 L70 170 L80 140 H40 Q20 140 20 120 Z"
                fill="none" 
                stroke="#d1d5db" 
                strokeWidth="4.5"/>
              <path d="M20 40 Q20 20 40 20 H280 Q300 20 300 40 V120 Q300 140 280 140 H100 L70 170 L80 140 H40 Q20 140 20 120 Z"
                fill="none" 
                stroke="#00d4ff" 
                strokeWidth="3"
                strokeLinecap="round"
                strokeDasharray="10 20"
                opacity="0.8">
                <animate attributeName="stroke-dashoffset" dur="1.5s" values="0;-30;0" repeatCount="indefinite"/>
                <animate attributeName="opacity" values="0.4;1;0.4" dur="1.5s" repeatCount="indefinite"/>
              </path>
              <path d="M20 40 Q20 20 40 20 H280 Q300 20 300 40 V120 Q300 140 280 140 H100 L70 170 L80 140 H40 Q20 140 20 120 Z"
                fill="none" 
                stroke="#0099cc" 
                strokeWidth="1"
                strokeLinecap="round"
                strokeDasharray="5 25"
                opacity="0.6">
                <animate attributeName="stroke-dashoffset" dur="1.5s" values="0;-30;0" repeatCount="indefinite" begin="0.3s"/>
                <animate attributeName="opacity" values="0.2;0.8;0.2" dur="1.5s" repeatCount="indefinite" begin="0.3s"/>
              </path>
              <g clipPath="url(#bubbleClip)">
                <path fill="none" 
                  stroke="#3b82f6" 
                  strokeWidth="8" 
                  strokeLinecap="round"
                  strokeDasharray="200 250" 
                  strokeDashoffset="0"
                  d="M235 80c0 20-18 32-32 32-38 0-60-65-98-65-18 0-32 14-32 32s15 32 32 32c38 0 60-65 98-65 16 0 32 12 32 32Z">
                  <animate attributeName="stroke-dashoffset" calcMode="spline" dur="2s" values="450;-450" keySplines="0 0 1 1" repeatCount="indefinite"/>
                </path>
              </g>
            </svg>
          </div>
          <div className="text-2xl font-bold mt-2">Loading Debate...</div>
        </div>
      ) : (
        // ... main debate UI ...
        <>
          {/* Main chat area with WhatsApp-like layout */}
          <div className="flex-1 flex flex-col justify-end px-2 md:px-8 py-6 overflow-y-auto scrollbar-fade" ref={debateContainerRef} style={{height: 'calc(100vh - 120px)'}}>
            {isJudging && (
              <div className="fixed inset-0 z-50 flex flex-col items-center justify-center bg-black bg-opacity-80">
                <div className="w-64 h-2 bg-gray-700 rounded-full overflow-hidden mb-6">
                  <div className="h-full bg-gradient-to-r from-blue-400 to-blue-600 animate-pulse" style={{ width: '100%' }}></div>
                </div>
                <div className="text-white text-lg font-semibold">Your debate is being evaluated...</div>
              </div>
            )}
            {currentDebate.arguments.length === 0 && pendingArguments.length === 0 ? (
              <div className="flex flex-col items-center justify-center h-full text-gray-400">
                <MessageSquare className="w-12 h-12 mb-4 text-gray-600" />
                {currentDebate.currentTurn === 'ai_opponent' ? (
                  <>
                    <p className="text-lg font-medium">AI opponent is starting the debate! 🤖</p>
                    <p className="text-sm text-gray-500 mt-2">Waiting for AI to make the first argument...</p>
                  </>
                ) : (
                  <>
                    <p className="text-lg font-medium">No arguments yet. Be the first to strike! ⚔️</p>
                    <p className="text-sm text-gray-500 mt-2">Start the debate with a powerful opening argument</p>
                  </>
                )}
                {deleteCountdown !== null && (
                  <div className="mt-4 text-red-400 text-base font-semibold">
                    This debate will be deleted in {deleteCountdown} second{deleteCountdown !== 1 ? 's' : ''} if no argument is made.
                  </div>
                )}
              </div>
            ) : (
              <>
                {/* Merge backend and pending arguments, filter out duplicates */}
                {chatArgumentsWithDisplayRound.map((arg, idx, arr) => {
                  const participant = currentDebate.participants.find(p => p.userId === arg.userId) || myParticipant;
                  const isMine = arg.userId === currentUser?.uid;
                  // Always align current user's arguments to the right, others to the left
                  const alignment = isMine ? 'justify-end' : 'justify-start';
                  const bubbleAlign = isMine ? 'flex-row-reverse' : 'flex-row';
                  // Avatar: current user always gets right avatar, others get left avatar based on stance
                  let avatarSrc;
                  if (isMine) {
                    avatarSrc = participant?.stance === 'pro' ? '/pro-right.png' : '/con-right.png';
                  } else {
                    avatarSrc = participant?.stance === 'pro' ? '/pro-left.png' : '/con-left.png';
                  }
                  return (
                    <div
                      key={arg.id}
                      className={`w-full flex ${alignment} mb-2`}
                    >
                      <div className={`flex ${bubbleAlign} items-end gap-3`} style={{maxWidth: '80%'}}>
                        {/* Even Larger Avatar */}
                        <img
                          src={avatarSrc}
                          alt={participant?.displayName}
                          className="w-40 h-52 object-contain rounded-3xl border-2 border-gray-700 bg-black shadow-md"
                          style={{minWidth: 160, minHeight: 208}}
                        />
                        {/* Bubble */}
                        <div
                          className={`rounded-2xl px-5 py-3 shadow-lg text-base whitespace-pre-line break-words
                            ${isMine
                              ? (participant?.stance === 'pro'
                                  ? 'bg-[#1a1a1a] text-green-200 border-r-4 border-green-500'
                                  : 'bg-[#181a22] text-red-200 border-l-4 border-red-500')
                              : (participant?.stance === 'pro'
                                  ? 'bg-[#1a1a1a] text-green-200 border-r-4 border-green-500'
                                  : 'bg-[#181a22] text-red-200 border-l-4 border-red-500')
                            }
                          `}
                          style={{minWidth: '0', flex: 1}}
                        >
                          <div className="flex items-center gap-2 mb-1">
                            <span className="font-bold text-sm">
                              {participant?.displayName}
                            </span>
                            <Badge variant={participant?.stance === 'pro' ? 'success' : 'error'} className="text-xs">
                              {participant?.stance?.toUpperCase()}
                            </Badge>
                            <span className="text-xs text-gray-500 dark:text-gray-400">Round {arg.displayRound}</span>
                          </div>
                          <div className="mb-1 text-white/90">{arg.content}</div>
                          <div className="flex items-center gap-2 text-xs text-gray-400">
                            <span>📝 {arg.wordCount} words</span>
                            <span>{new Date(arg.timestamp).toLocaleTimeString()}</span>
                          </div>
                        </div>
                      </div>
                    </div>
                  );
                })}
                {/* AI Typing Indicator: only when it's AI's turn and after user's pending argument */}
                {isAITyping && !isDebateCompleted && currentDebate.currentTurn === 'ai_opponent' && (() => {
                  // Find AI participant
                  const aiParticipant = currentDebate.participants.find(p => p.userId === 'ai_opponent');
                  const isAIPro = aiParticipant?.stance === 'pro';
                  const isAICon = aiParticipant?.stance === 'con';
                  
                  // Stance toggle logic for AI typing indicator
                  const userStance = practiceSettings?.userStance || 'pro';
                  const shouldSwapSides = userStance === 'con';
                  
                  // AI avatar image with stance toggle support
                  let aiAvatarSrc;
                  if (shouldSwapSides) {
                    aiAvatarSrc = isAIPro ? '/pro-left.png' : '/con-right.png';
                  } else {
                    aiAvatarSrc = isAIPro ? '/pro-right.png' : '/con-left.png';
                  }
                  
                  // AI alignment with stance toggle support
                  let aiAlignment, aiBubbleAlign;
                  if (shouldSwapSides) {
                    aiAlignment = isAIPro ? 'justify-start' : 'justify-end';
                    aiBubbleAlign = isAIPro ? 'flex-row' : 'flex-row-reverse';
                  } else {
                    aiAlignment = isAICon ? 'justify-start' : 'justify-end';
                    aiBubbleAlign = isAICon ? 'flex-row' : 'flex-row-reverse';
                  }
                  
                  return (
                    <div className={`w-full flex ${aiAlignment} mb-2`}>
                      <div className={`flex ${aiBubbleAlign} items-end gap-3 max-w-[80%]`}>
                        <img
                          src={aiAvatarSrc}
                          alt="AI Opponent"
                          className="w-32 h-40 object-cover rounded-3xl border-2 border-gray-700 bg-black shadow-md"
                          style={{minWidth: 128, minHeight: 160}}
                        />
                        <div className="rounded-2xl px-5 py-3 shadow-lg text-base bg-[#1a1a1a] border-r-4 border-green-500 flex items-center">
                          <TypingIndicator />
                        </div>
                      </div>
                    </div>
                  );
                })()}
              </>
            )}
          </div>
          {/* Fixed input at the bottom */}
          <div className="w-full bg-[#101010] border-t border-gray-800 px-2 md:px-8 py-4 flex flex-col gap-0 sticky bottom-0 z-20" style={{boxShadow: '0 -2px 16px 0 #0008'}}>
            {/* Drag handle */}
            <div
              ref={dragHandleRef}
              className="w-full h-3 flex items-center justify-center cursor-ns-resize select-none"
              style={{marginBottom: '2px'}}
              onMouseDown={e => {
                draggingRef.current = true;
                lastYRef.current = e.clientY;
              }}
            >
              <div className="w-16 h-1.5 rounded bg-gray-700" />
            </div>
            <div className="flex items-center gap-3">
              {/* End Debate button on the left */}
              <Button
                onClick={handleEndDebate}
                disabled={!currentDebate || isSubmitting || isDebateCompleted}
                className={`px-6 py-2 rounded-xl font-semibold transition-all duration-300 flex items-center gap-2 bg-gradient-to-r from-orange-500 to-red-500 text-white hover:from-orange-600 hover:to-red-600 shadow-lg hover:shadow-xl mr-2 ${isDebateCompleted ? 'opacity-60 cursor-not-allowed' : ''}`}
                title="End Debate"
              >
                <Flag className="w-5 h-5" />
              </Button>
              {/* Voice input button: hide on Brave/Firefox */}
              {!isBraveOrFirefox && (
                <Button
                  onClick={isRecording ? handleStopRecording : handleStartRecording}
                  disabled={isTranscribing || isSubmitting || isDebateCompleted}
                  className={`px-3 py-2 rounded-xl font-semibold flex items-center gap-2 ${isRecording ? 'bg-red-600 text-white animate-pulse' : 'bg-blue-700 text-white'} ${isTranscribing ? 'opacity-60 cursor-not-allowed' : ''}`}
                  title={isRecording ? 'Stop Recording' : 'Start Voice Input'}
                >
                  <Mic className="w-5 h-5" />
                </Button>
              )}
              {/* Argument input */}
              <textarea
                ref={argumentInputRef}
                value={argument}
                onChange={e => {
                  setArgument(e.target.value);
                  handleTyping(e.target.value.length > 0);
                }}
                onKeyDown={e => {
                  if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault();
                    if (isMyTurn && argument.trim() && !isSubmitting && !isDebateCompleted && !isTranscribing) {
                      handleSubmitArgument();
                    }
                  }
                  // Shift+Enter inserts newline (default behavior)
                }}
                onPaste={e => {
                  e.preventDefault();
                  return false;
                }}
                onBlur={() => handleTyping(false)}
                placeholder={isDebateCompleted ? 'Debate has ended.' : isMyTurn ? 'Type your argument...' : 'Waiting for your turn...'}
                disabled={!isMyTurn || isSubmitting || isDebateCompleted || isTranscribing}
                className={`flex-1 rounded-xl px-4 py-3 text-base border-2 focus:ring-2 transition-all duration-200
                  ${isMyTurn && !isDebateCompleted ? 'border-green-500 focus:ring-green-600' : 'border-gray-700'}
                  bg-black text-white placeholder-gray-500
                  ${!isMyTurn || isSubmitting || isDebateCompleted || isTranscribing ? 'opacity-60 cursor-not-allowed' : ''}
                `}
                style={{height: inputHeight, minHeight: 48, maxHeight: 240, resize: 'none'}}
                rows={2}
              />
              {/* Send button */}
              <Button
                onClick={handleSubmitArgument}
                disabled={!isMyTurn || !argument.trim() || isSubmitting || isDebateCompleted || isTranscribing}
                className={`px-6 py-2 rounded-xl font-semibold transition-all duration-300 flex items-center gap-2
                  ${isMyTurn && argument.trim() && !isSubmitting && !isDebateCompleted && !isTranscribing ? 'bg-gradient-to-r from-green-500 to-emerald-500 text-white hover:from-green-600 hover:to-emerald-600 shadow-lg hover:shadow-xl' : 'bg-gray-700 text-gray-400 cursor-not-allowed'}
                `}
                title="Send Argument"
              >
                {isSubmitting ? (
                  <div className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin"></div>
                ) : (
                  <SendIcon className="w-5 h-5" />
                )}
              </Button>
            </div>
            {/* Transcribing/recording status and errors */}
            {isRecording && (
              <div className="text-sm text-blue-400 mt-2 flex items-center gap-2 animate-pulse">
                <span>Recording... Speak now.</span>
              </div>
            )}
            {isTranscribing && (
              <div className="text-sm text-blue-400 mt-2 flex items-center gap-2 animate-pulse">
                <span>Transcribing voice input...</span>
              </div>
            )}
            {voiceError && (
              <div className="text-sm text-red-400 mt-2 flex items-center gap-2">
                <span>{voiceError}</span>
              </div>
            )}
          </div>
          {/* After the chat area, but before the modals, add a new section for winner and scores if debate is completed and judgment is present */}
          {isDebateCompleted && currentDebate.judgment && (() => {
            const judgment = currentDebate.judgment;
            // Winner: try userId, then displayName
            let winnerId = judgment.winner;
            let winnerParticipant = currentDebate.participants.find(
              p => p.userId === winnerId || p.displayName === winnerId
            );
            let winnerName = winnerParticipant?.displayName || winnerId || "No winner";
            // Scores: robust mapping
            const getScore = (uid: string) => {
              if (judgment.scores?.[uid] !== undefined) return judgment.scores[uid];
              // Try to find by displayName if not found by userId
              const participant = currentDebate.participants.find(p => p.displayName === uid);
              if (participant && judgment.scores?.[participant.userId] !== undefined) {
                return judgment.scores[participant.userId];
              }
              return null;
            };
            return (
              <div className="w-full max-w-2xl mx-auto mt-8 p-6 bg-[#181a22] rounded-2xl border border-gray-700 text-white">
                <div className="text-xl font-bold mb-2 flex items-center gap-2">
                  <span>🏆 Winner:</span>
                  <span className="text-green-400">{winnerName}</span>
                </div>
                <div className="flex flex-col md:flex-row gap-4 mt-2">
                  {currentDebate.participants.map((participant) => {
                    const score = getScore(participant.userId) ?? getScore(participant.displayName);
                    return (
                      <div key={participant.userId} className="flex-1 bg-[#101014] rounded-xl p-4 border border-gray-800">
                        <div className="font-semibold text-lg mb-1">{participant.displayName}</div>
                        <div className="text-2xl font-bold text-blue-400 mb-2">
                          {typeof score === 'number' ? score.toFixed(1) + '/10' : 'No score returned by judge'}
                        </div>
                        <ul className="text-sm text-gray-300 list-disc pl-5">
                          {(judgment.feedback?.[participant.userId] || judgment.feedback?.[participant.displayName] || []).map((fb, i) => (
                            <li key={i}>{fb}</li>
                          ))}
                        </ul>
                      </div>
                    );
                  })}
                </div>
              </div>
            );
          })()}
          {/* Modals, overlays, and toasts remain unchanged below */}

          {/* Coaching Tip Modal */}
          <Modal
            open={showCoaching}
            onClose={() => setShowCoaching(false)}
          >
            <div className="p-6">
              <h3 className="text-lg font-semibold mb-4">AI Coaching Tip</h3>
              <p className="text-gray-700 mb-4">{coachingTip}</p>
              <Button onClick={() => setShowCoaching(false)}>
                Got it!
              </Button>
            </div>
          </Modal>

          {/* Judgment Modal */}
          <Modal
            open={showJudgment}
            onClose={() => setShowJudgment(false)}
          >
            <div className="p-6 max-h-[80vh] overflow-y-auto bg-white dark:bg-gray-900 text-gray-900 dark:text-white">
              {currentDebate.judgment && (() => {
                const judgment = currentDebate.judgment as typeof currentDebate.judgment & { learningPoints?: string[] };
                // Winner: try userId, then displayName
                let winnerId = judgment.winner;
                let winnerParticipant = currentDebate.participants.find(
                  p => p.userId === winnerId || p.displayName === winnerId
                );
                let winnerName = winnerParticipant?.displayName || winnerId || "No winner";
                // Scores: robust mapping
                const getScore = (uid: string) => {
                  if (judgment.scores?.[uid] !== undefined) return judgment.scores[uid];
                  // Try to find by displayName if not found by userId
                  const participant = currentDebate.participants.find(p => p.displayName === uid);
                  if (participant && judgment.scores?.[participant.userId] !== undefined) {
                    return judgment.scores[participant.userId];
                  }
                  return null;
                };
                // Feedback: robust mapping
                const getFeedback = (uid: string) => {
                  return (
                    judgment.feedback?.[uid] ||
                    judgment.feedback?.[currentDebate.participants.find(p => p.userId === uid)?.displayName || ''] ||
                    []
                  );
                };
                return (
                  <div className="space-y-6">
                    {/* Winner */}
                    <div className="text-center">
                      <h3 className="text-2xl font-bold text-gray-900 dark:text-white mb-2">
                        🏆 Winner: {winnerName}
                      </h3>
                      <p className="text-gray-700 dark:text-gray-300">{judgment.reasoning}</p>
                    </div>

                    {/* Scores */}
                    <div className="grid grid-cols-2 gap-4">
                      {currentDebate.participants.map((participant) => {
                        const score = getScore(participant.userId) ?? getScore(participant.displayName);
                        const feedbackArr = getFeedback(participant.userId);
                        const ratingChange = currentDebate.ratingChanges?.[participant.userId] || 0;
                        const isCurrentUser = participant.userId === currentUser?.uid;
                        return (
                          <div key={participant.userId} className="p-4 border border-gray-200 dark:border-gray-700 rounded-lg bg-gray-50 dark:bg-gray-800">
                            <h4 className="font-semibold mb-2 text-gray-900 dark:text-white flex items-center justify-between">
                              <span>{participant.displayName}</span>
                              {isCurrentUser && (
                                <div className={`text-sm font-medium px-2 py-1 rounded ${
                                  ratingChange > 0 ? 'bg-green-100 dark:bg-green-900 text-green-800 dark:text-green-300' : 
                                  ratingChange < 0 ? 'bg-red-100 dark:bg-red-900 text-red-800 dark:text-red-300' : 
                                  'bg-gray-100 dark:bg-gray-700 text-gray-600 dark:text-gray-300'
                                }`}>
                                  {ratingChange > 0 ? '+' : ''}{ratingChange} ELO
                                </div>
                              )}
                            </h4>
                            <div className="text-2xl font-bold text-blue-600 dark:text-blue-400 mb-2">
                              {typeof score === 'number' ? `${score.toFixed(1)}/10` : 'No score returned by judge'}
                            </div>
                            <div className="space-y-1">
                              {feedbackArr.length > 0 ? feedbackArr.map((feedback, index) => (
                                <p key={index} className="text-sm text-gray-600 dark:text-gray-300">• {feedback}</p>
                              )) : <p className="text-sm text-gray-400">No feedback</p>}
                            </div>
                          </div>
                        );
                      })}
                    </div>

                    {/* Highlights */}
                    <div>
                      <h4 className="font-semibold mb-2 text-gray-900 dark:text-white">Debate Highlights</h4>
                      <ul className="space-y-1">
                        {judgment.highlights?.map((highlight, index) => (
                          <li key={index} className="text-sm text-gray-600 dark:text-gray-300">• {highlight}</li>
                        ))}
                      </ul>
                    </div>

                    {/* Learning Points */}
                    <div>
                      <h4 className="font-semibold mb-2 text-gray-900 dark:text-white">Learning Points</h4>
                      <ul className="space-y-1">
                        {Array.isArray((judgment as any).learningPoints) && (judgment as any).learningPoints.length > 0 ? (judgment as any).learningPoints.map((point: string, idx: number) => (
                          <li key={idx} className="text-sm text-gray-600 dark:text-gray-300">• {point}</li>
                        )) : (
                          <>
                            <li className="text-sm text-gray-600 dark:text-gray-300">• Continue practicing debate skills</li>
                            <li className="text-sm text-gray-600 dark:text-gray-300">• Focus on evidence and logical structure</li>
                            <li className="text-sm text-gray-600 dark:text-gray-300">• Improve rebuttal techniques</li>
                          </>
                        )}
                      </ul>
                    </div>

                    <div className="flex gap-2">
                      <Button
                        variant="outline"
                        onClick={() => navigate('/find-debate')}
                        className="flex-1 border-gray-300 dark:border-gray-600 text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700"
                      >
                        Find New Debate
                      </Button>
                      <Button
                        onClick={() => setShowJudgment(false)}
                        className="flex-1 bg-blue-600 hover:bg-blue-700 text-white"
                      >
                        Close
                      </Button>
                    </div>
                  </div>
                );
              })()}
            </div>
          </Modal>

          {/* Winner Animation */}
          {showWinner && currentDebate.judgment && (
            <ConfettiAnimation />
          )}

          {/* Error Toast */}
          {error && (
            <div className="fixed top-4 right-4 bg-red-500 text-white p-4 rounded-lg shadow-lg z-50">
              <div className="flex items-center justify-between">
                <span>{error}</span>
                <button onClick={() => {}} className="ml-4 text-white hover:text-gray-200">
                  ×
                </button>
              </div>
            </div>
          )}

          {/* Judgment Result Modal */}
          {showJudgmentModal && judgmentResult && (
            <Modal open={showJudgmentModal} onClose={() => setShowJudgmentModal(false)}>
              <div className="p-6 max-h-[80vh] overflow-y-auto bg-white dark:bg-gray-900 text-gray-900 dark:text-white">
                <h3 className="text-lg font-semibold mb-4 text-gray-900 dark:text-white">AI Debate Result</h3>
                <div className="mb-2 text-gray-700 dark:text-gray-300"><strong className="text-gray-900 dark:text-white">Winner:</strong> {currentDebate?.participants.find(p => p.userId === judgmentResult.winner)?.displayName || 'N/A'}</div>
                <div className="mb-2 text-gray-700 dark:text-gray-300"><strong className="text-gray-900 dark:text-white">Reasoning:</strong> {judgmentResult.reasoning}</div>
                <div className="mb-2 text-gray-700 dark:text-gray-300"><strong className="text-gray-900 dark:text-white">Scores:</strong></div>
                <ul className="mb-2 text-gray-700 dark:text-gray-300">
                  {judgmentResult.scores && typeof judgmentResult.scores === 'object' &&
                    (Object.entries(judgmentResult.scores) as [string, number][]).map(([uid, score], idx) => {
                      const ratingChange = currentDebate?.ratingChanges?.[uid] || 0;
                      const isCurrentUser = uid === currentUser?.uid;
                      return (
                        <li key={uid || idx} className="flex items-center justify-between">
                          <span>
                            {currentDebate?.participants.find(p => p.userId === uid)?.displayName || uid}: {typeof score === 'number' && !isNaN(score) && score !== undefined ? `${score}/10` : 'N/A'}
                          </span>
                          {isCurrentUser && (
                            <span className={`text-sm font-medium px-2 py-1 rounded ${
                              ratingChange > 0 ? 'bg-green-100 dark:bg-green-900 text-green-800 dark:text-green-300' : 
                              ratingChange < 0 ? 'bg-red-100 dark:bg-red-900 text-red-800 dark:text-red-300' : 
                              'bg-gray-100 dark:bg-gray-700 text-gray-600 dark:text-gray-300'
                            }`}>
                              {ratingChange > 0 ? '+' : ''}{ratingChange} ELO
                            </span>
                          )}
                        </li>
                      );
                    })}
                </ul>
                <div className="mb-2 text-gray-700 dark:text-gray-300"><strong className="text-gray-900 dark:text-white">Areas to Improve:</strong></div>
                <ul className="text-gray-700 dark:text-gray-300">
                  {judgmentResult.learningPoints?.map((point: string, idx: number) => (
                    <li key={idx}>• {point}</li>
                  ))}
                </ul>
                {judgmentResult.highlights && judgmentResult.highlights.length > 0 && (
                  <>
                    <div className="mt-4 mb-2 font-semibold text-gray-900 dark:text-white">Debate Highlights</div>
                    <ul className="text-gray-700 dark:text-gray-300">
                      {judgmentResult.highlights.map((highlight: string, idx: number) => (
                        <li key={idx}>• {highlight}</li>
                      ))}
                    </ul>
                  </>
                )}
                <Button onClick={() => setShowJudgmentModal(false)} className="mt-4 bg-blue-600 hover:bg-blue-700 text-white">Close</Button>
              </div>
            </Modal>
          )}


        </>
      )}
    </div>
  );
};
