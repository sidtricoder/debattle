import React, { useState, useEffect, useRef } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { onSnapshot, doc, updateDoc, arrayUnion, getDoc, increment, runTransaction } from 'firebase/firestore';
import { firestore } from '../../lib/firebase';
import { useAuthStore } from '../../stores/authStore';
import { judgeWithGroq } from '../../services/ai/deepseek';
import { calculateDebateRatings } from '../../services/debate/elo-calculator';

import Button from '../ui/Button';
import { Badge } from '../ui/Badge';
import { LoadingSpinner } from '../animations/LoadingSpinner';
import { ConfettiAnimation } from '../animations/ConfettiAnimation';
import { Modal } from '../ui/Modal';
import { 
  Flag, 
  Sun, 
  Moon, 
  Clock, 
  RotateCcw, 
  Send as SendIcon, 
  MessageSquare,
  Mic,
  X,
  Clipboard
} from 'lucide-react';

// Constants for user vs user debates
const MAX_ROUNDS = 5;
const TURN_TIME_SECONDS = 60;

interface DebateArgument {
  id: string;
  userId: string;
  content: string;
  timestamp: number;
  round: number;
  wordCount: number;
}

interface DebateParticipant {
  userId: string;
  displayName: string;
  stance: 'pro' | 'con';
}

interface Debate {
  id: string;
  topic: string;
  participants: DebateParticipant[];
  arguments: DebateArgument[];
  status: 'waiting' | 'active' | 'completed';
  currentTurn: string; // userId of current turn
  currentRound: number;
  judgment?: any;
  ratings?: Record<string, number>;
  ratingChanges?: Record<string, number>;
  createdAt: Date;
  proVotes?: number;
  conVotes?: number;
}

export const UsersDebateRoom: React.FC = () => {
  const { roomId } = useParams<{ roomId: string }>();
  const navigate = useNavigate();
  const { user: currentUser, refreshUserData } = useAuthStore();
  
  // State
  const [debate, setDebate] = useState<Debate | null>(null);
  const [argument, setArgument] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [timeLeft, setTimeLeft] = useState(TURN_TIME_SECONDS);
  const [isDarkMode, setIsDarkMode] = useState(() => document.documentElement.classList.contains('dark'));
  const [isJudging, setIsJudging] = useState(false);
  const [showJudgment, setShowJudgment] = useState(false);
  const [showWinner, setShowWinner] = useState(false);
  const [isMyTurn, setIsMyTurn] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [participantDetails, setParticipantDetails] = useState<Record<string, any>>({});
  
  // Voice input state
  const [isRecording, setIsRecording] = useState(false);
  const [isTranscribing, setIsTranscribing] = useState(false);
  const [voiceError, setVoiceError] = useState<string | null>(null);
  const [inputHeight, setInputHeight] = useState(48);
  
  // Browser detection for mic button (copy from DebateRoom.tsx)
  const [isBraveOrFirefox, setIsBraveOrFirefox] = useState(false);
  useEffect(() => {
    const ua = navigator.userAgent.toLowerCase();
    const isFirefox = ua.includes('firefox');
    const isBrave = (navigator as any).brave && typeof (navigator as any).brave.isBrave === 'function';
    setIsBraveOrFirefox(isFirefox || isBrave);
  }, []);
  
  // Refs
  const debateContainerRef = useRef<HTMLDivElement>(null);
  const argumentInputRef = useRef<HTMLTextAreaElement>(null);
  const dragHandleRef = useRef<HTMLDivElement>(null);
  const draggingRef = useRef(false);
  const lastYRef = useRef(0);
  const timerRef = useRef<NodeJS.Timeout | null>(null);
  const recognitionRef = useRef<any>(null);

  // Add voting state
  const [hasVoted, setHasVoted] = useState<boolean>(false);

  // Add state for copy success
  const [copySuccess, setCopySuccess] = useState(false);

  // Create participant details mapping using auth store data
  // (Assume currentUser is always up-to-date from auth store)
  const createParticipantDetails = async (participants: DebateParticipant[]) => {
    const userDetails: Record<string, any> = {};
    
    // Fetch fresh display names for all participants
    for (const participant of participants) {
      let displayName = participant.displayName;
      
      // If the display name looks like a fallback or is missing, try to fetch from Firestore
      if (participant.userId !== 'ai_opponent' && 
          (!displayName || displayName.startsWith('User ') || displayName === 'You' || displayName === 'Opponent')) {
        try {
          const userDoc = await getDoc(doc(firestore, 'users', participant.userId));
          if (userDoc.exists()) {
            const userData = userDoc.data();
            displayName = userData.displayName || userData.username || `User ${participant.userId.slice(-4)}`;
          }
        } catch (error) {
          console.warn('Failed to fetch display name for user:', participant.userId, error);
          displayName = displayName || `User ${participant.userId.slice(-4)}`;
        }
      }
      
      userDetails[participant.userId] = {
        displayName,
        userId: participant.userId,
        stance: participant.stance,
      };
    }
    
    setParticipantDetails(userDetails);
  };

  // Subscribe to debate
  useEffect(() => {
    if (!roomId) {
      console.log('[DEBUG] UsersDebateRoom: No roomId provided');
      setError('No debate ID in URL.');
      setIsLoading(false);
      return;
    }

    console.log('[DEBUG] UsersDebateRoom: Subscribing to debate with Firestore ID:', roomId);
    setIsLoading(true);
    setError(null);

    const unsub = onSnapshot(
      doc(firestore, 'debates', roomId),
      (docSnap) => {
        console.log('[DEBUG] UsersDebateRoom: onSnapshot callback triggered');
        console.log('[DEBUG] UsersDebateRoom: docSnap.exists():', docSnap.exists());
        console.log('[DEBUG] UsersDebateRoom: docSnap.id:', docSnap.id);

        if (docSnap.exists()) {
          const rawData = docSnap.data();
          console.log('[DEBUG] UsersDebateRoom: Raw Firestore data:', rawData);

          const debateData = { id: docSnap.id, ...rawData } as Debate;
          console.log('[DEBUG] UsersDebateRoom: Processed debate data:', debateData);

          setDebate(debateData);
          
          // Create participant details when debate loads
          if (debateData.participants) {
            console.log('[DEBUG] UsersDebateRoom: About to create participant details for:', debateData.participants);
            createParticipantDetails(debateData.participants).catch(error => {
              console.error('[DEBUG] UsersDebateRoom: Failed to create participant details:', error);
            });
          }
          
          setIsLoading(false);

          if (debateData.status === 'completed' && debateData.judgment) {
            setShowJudgment(true);
            setShowWinner(true);
          }
        } else {
          console.error('[DEBUG] UsersDebateRoom: Debate not found in Firestore:', roomId);
          setError('Debate not found');
          setIsLoading(false);
        }
      },
      (error) => {
        console.error('[DEBUG] UsersDebateRoom: Error subscribing to debate:', error);
        console.error('[DEBUG] UsersDebateRoom: Error details:', {
          code: error.code,
          message: error.message,
          stack: error.stack,
        });
        setError('Failed to load debate');
        setIsLoading(false);
      }
    );

    return () => {
      console.log('[DEBUG] UsersDebateRoom: Cleaning up subscription');
      unsub();
    };
  }, [roomId]);

  // Scroll to bottom on new message
  useEffect(() => {
    if (debateContainerRef.current) {
      debateContainerRef.current.scrollTo({
        top: debateContainerRef.current.scrollHeight,
        behavior: 'smooth'
      });
    }
  }, [debate?.arguments]);

  // Voice input handlers
  const handleStartRecording = () => {
    if (!('webkitSpeechRecognition' in window) && !('SpeechRecognition' in window)) {
      setVoiceError('Speech recognition not supported in this browser');
      return;
    }

    const SpeechRecognition = (window as any).webkitSpeechRecognition || (window as any).SpeechRecognition;
    const recognition = new SpeechRecognition();
    
    recognition.continuous = true;  // Keep recording during pauses
    recognition.interimResults = true;  // Show partial results
    recognition.lang = 'en-US';
    
    let finalTranscript = '';
    
    recognition.onstart = () => {
      setIsRecording(true);
      setVoiceError(null);
    };
    
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
        setArgument(prev => prev + (prev ? ' ' : '') + finalTranscript.trim());
        finalTranscript = '';
      }
    };
    
    recognition.onerror = (event: any) => {
      // Only show error and stop if it's a real error, not just no-speech
      if (event.error !== 'no-speech') {
        setVoiceError(`Voice recognition error: ${event.error}`);
        setIsRecording(false);
        setIsTranscribing(false);
      }
    };
    
    recognition.onend = () => {
      // Only stop if we're not supposed to be recording anymore
      if (isRecording) {
        setIsRecording(false);
        setIsTranscribing(false);
      }
    };
    
    recognitionRef.current = recognition;
    recognition.start();
  };

  const handleStopRecording = () => {
    if (recognitionRef.current) {
      recognitionRef.current.stop();
      setIsRecording(false);
      setIsTranscribing(false);
    }
  };

  // Cleanup voice recognition on unmount
  useEffect(() => {
    return () => {
      if (recognitionRef.current) {
        recognitionRef.current.stop();
      }
    };
  }, []);

  // Update participant details when current user changes
  useEffect(() => {
    if (debate?.participants && currentUser) {
      console.log('[DEBUG] UsersDebateRoom: Current user changed, updating participant details');
      createParticipantDetails(debate.participants).catch(error => {
        console.error('[DEBUG] UsersDebateRoom: Failed to update participant details:', error);
      });
    }
  }, [currentUser, debate?.participants]);

  // Auto-start debate when both users are present
  useEffect(() => {
    if (!debate || !currentUser || debate.status !== 'waiting') return;
    
    // Check if both participants are present (we can assume they are if the debate is loaded)
    // and automatically start the debate
    const startDebate = async () => {
      try {
        console.log('[DEBUG] Auto-starting debate - changing status to active');
        await updateDoc(doc(firestore, 'debates', debate.id), {
          status: 'active'
        });
      } catch (error) {
        console.error('[DEBUG] Failed to start debate:', error);
      }
    };
    
    startDebate();
  }, [debate, currentUser]);

  // Determine if it's my turn
  useEffect(() => {
    if (!debate || !currentUser) return;
    setIsMyTurn(debate.currentTurn === currentUser.uid);
    
    if (debate.currentTurn === currentUser.uid && argumentInputRef.current) {
      argumentInputRef.current.focus();
    }
  }, [debate, currentUser]);

  // Timer logic
  useEffect(() => {
    if (!isMyTurn || !debate || debate.status !== 'active') return;
    setTimeLeft(TURN_TIME_SECONDS);
    if (timerRef.current) clearInterval(timerRef.current);
    timerRef.current = setInterval(() => {
      setTimeLeft((prev) => {
        if (prev <= 1) {
          clearInterval(timerRef.current!);
          handleAutoSubmit();
          
          // If this was the last round, end the debate
          if (debate.currentRound > MAX_ROUNDS) {
            console.log('[DEBUG] UsersDebateRoom: Timer expired on last round, ending debate');
            setTimeout(() => handleEndDebate(), 1000); // Small delay to allow auto-submit to complete
          }
          
          return 0;
        }
        return prev - 1;
      });
    }, 1000);
    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, [isMyTurn, debate?.currentTurn, debate?.status]);



  // Argument submission
  // 3. When submitting an argument, use the same structure as DebateRoom.tsx
  const handleSubmitArgument = async () => {
    if (!debate || !currentUser || !argument.trim() || !isMyTurn || isSubmitting || debate.status !== 'active') return;
    setIsSubmitting(true);
    try {
      // Calculate round: one round = two arguments
      const nextArgIndex = (debate.arguments?.length || 0);
      const roundNum = Math.floor(nextArgIndex / 2) + 1;
      const newArgument = {
        id: `arg_${Date.now()}`,
        userId: currentUser.uid,
        content: argument.trim(),
        timestamp: Date.now(),
        round: roundNum,
        wordCount: argument.trim().split(' ').length,
      };
      // Add argument
      const updatedArguments = [...(debate.arguments || []), newArgument];
      console.log('[DEBUG] handleSubmitArgument: Adding argument:', newArgument);
      console.log('[DEBUG] handleSubmitArgument: Updated arguments array:', updatedArguments);
      
      // Determine if this is the pro or con participant
      const currentUserStance = debate.participants.find(p => p.userId === currentUser.uid)?.stance;
      
      // Only increment currentRound after both debaters have submitted for this round
      let updatedCurrentRound = debate.currentRound;
      let shouldEndDebate = false;
      
      if (currentUserStance === 'pro') {
        // Pro just spoke, con's turn next (same round)
        console.log('[DEBUG] handleSubmitArgument: Pro spoke, con\'s turn next');
      } else {
        // Con just spoke, round is complete, move to next round
        updatedCurrentRound = debate.currentRound + 1;
        console.log('[DEBUG] handleSubmitArgument: Con spoke, moving to round:', updatedCurrentRound);
        
        // Check if debate should end (after con speaks in the final round)
        if (updatedCurrentRound > MAX_ROUNDS) {
          shouldEndDebate = true;
          console.log('[DEBUG] handleSubmitArgument: Should end debate - rounds exceeded');
        }
      }
      
      // Update debate document
      if (shouldEndDebate) {
        // Save the final argument first, then end the debate
        await updateDoc(doc(firestore, 'debates', debate.id), {
          arguments: updatedArguments,
          currentRound: updatedCurrentRound,
          status: 'active', // Keep as active temporarily
        });
        setArgument('');
        
        // Now end the debate after ensuring the argument is saved
        setTimeout(async () => {
          await updateDoc(doc(firestore, 'debates', debate.id), {
            status: 'completed',
          });
          handleEndDebate();
        }, 500);
        return;
      } else {
        await updateDoc(doc(firestore, 'debates', debate.id), {
          arguments: updatedArguments,
          currentTurn: debate.participants.find(p => p.userId !== currentUser.uid)?.userId || '',
          currentRound: updatedCurrentRound,
          status: 'active',
        });
      }
      
      setArgument('');
    } catch (e) {
      console.error('Failed to submit argument:', e);
    } finally {
      setIsSubmitting(false);
    }
  };

  // Auto submit empty argument if time runs out
  const handleAutoSubmit = async () => {
    if (!debate || !currentUser || !isMyTurn || debate.status !== 'active') return;
    try {
      const nextArgIndex = (debate.arguments?.length || 0);
      const roundNum = Math.floor(nextArgIndex / 2) + 1;
      const newArgument: DebateArgument = {
        id: `arg_${Date.now()}`,
        userId: currentUser.uid,
        content: '[No argument submitted]',
        timestamp: Date.now(),
        round: roundNum,
        wordCount: 0,
      };
      const updatedArguments = [...(debate.arguments || []), newArgument];
      console.log('[DEBUG] handleAutoSubmit: Adding auto-argument:', newArgument);
      console.log('[DEBUG] handleAutoSubmit: Updated arguments array:', updatedArguments);
      
      // Determine if this is the pro or con participant
      const currentUserStance = debate.participants.find(p => p.userId === currentUser.uid)?.stance;
      
      let updatedCurrentRound = debate.currentRound;
      let shouldEndDebate = false;
      
      if (currentUserStance === 'pro') {
        // Pro just spoke, con's turn next (same round)
        // No round increment yet
      } else {
        // Con just spoke, round is complete, move to next round
        updatedCurrentRound = debate.currentRound + 1;
        
        // Check if debate should end (after con speaks in the final round)
        if (updatedCurrentRound > MAX_ROUNDS) {
          shouldEndDebate = true;
        }
      }
      
      if (shouldEndDebate) {
        // Save the final argument first, then end the debate
        await updateDoc(doc(firestore, 'debates', debate.id), {
          arguments: updatedArguments,
          currentRound: updatedCurrentRound,
          status: 'active', // Keep as active temporarily
        });
        
        // Now end the debate after ensuring the argument is saved
        setTimeout(async () => {
          await updateDoc(doc(firestore, 'debates', debate.id), {
            status: 'completed',
          });
          handleEndDebate();
        }, 500);
      } else {
        await updateDoc(doc(firestore, 'debates', debate.id), {
          arguments: updatedArguments,
          currentTurn: debate.participants.find(p => p.userId !== currentUser.uid)?.userId || '',
          currentRound: updatedCurrentRound,
          status: 'active',
        });
      }
    } catch (e) {
      console.error('Failed to auto submit:', e);
    }
  };

  // End debate and judge
  // 5. When ending the debate, update the full debate object with all metadata, arguments, participants, etc.
  const handleEndDebate = async () => {
    if (!debate || !currentUser) return;
    
    let latestDebateData = debate; // Default fallback
    
    try {
      setIsJudging(true);
      
      // Fetch the latest debate data to ensure we have all arguments
      const debateDoc = await getDoc(doc(firestore, 'debates', debate.id));
      if (!debateDoc.exists()) {
        console.error('Debate document not found');
        setIsJudging(false);
        return;
      }
      
      latestDebateData = { id: debateDoc.id, ...debateDoc.data() } as Debate;
      console.log('[DEBUG] handleEndDebate: Latest debate data:', latestDebateData);
      console.log('[DEBUG] handleEndDebate: Arguments count:', latestDebateData.arguments?.length || 0);
      
      // Check if debate has enough arguments for judgment
      if (latestDebateData.arguments.length < 2) {
        // End debate without judgment if not enough arguments
        const updatedDebate = {
          ...latestDebateData,
          status: 'completed',
          endedAt: Date.now(),
          endReason: 'insufficient_arguments',
        };
        await updateDoc(doc(firestore, 'debates', debate.id), updatedDebate);
        setIsJudging(false);
        return;
      }

      // Prepare prompt for judge with strict evaluation criteria
      const prompt = `YOU ARE AN EXPERT DEBATE JUDGE. EVALUATE THE FOLLOWING DEBATE AND RETURN ONLY A VALID JSON OBJECT.\n\nSTRICT EVALUATION RULES:\n1. IF NO MEANINGFUL POINTS ARE MADE BY ANYONE: GIVE ZERO TO ALL PARTICIPANTS\n2. IF ANY PARTICIPANT USES ABUSIVE LANGUAGE OR MAKES CONTROVERSIAL STATEMENTS ABOUT RELIGION, COMMUNITY, OR REGION: GIVE ZERO TO THAT PARTICIPANT\n3. ONLY SCORE ARGUMENTS MADE IN ENGLISH, HINDI, OR HINGLISH\n\nOUTPUT FORMAT (JSON ONLY):\n{\n  "winner": "<userId of winner or null if draw>",\n  "scores": {\n    "<userId1>": <score 0-10, float, 1 decimal>,\n    "<userId2>": <score 0-10, float, 1 decimal>\n  },\n  "feedback": {\n    "<userId1>": ["<strength1>", "<weakness1>", "<improvement1>"],\n    "<userId2>": ["<strength1>", "<weakness1>", "<improvement1>"]\n  },\n  "reasoning": "<detailed explanation of decision>",\n  "highlights": ["<key moment1>", "<key moment2>"],\n  "learningPoints": ["<learning_point1>", "<learning_point2>"]\n}\n\nDEBATE DATA:\nTOPIC: ${latestDebateData.topic}\n\nPARTICIPANTS:\n${latestDebateData.participants.map(p => `- ${p.displayName} (${p.userId}): ${p.stance.toUpperCase()}`).join('\n')}\n\nARGUMENTS:\n${latestDebateData.arguments.map(arg => `ROUND ${arg.round} - ${latestDebateData.participants.find(p => p.userId === arg.userId)?.displayName}: "${arg.content}"`).join('\n\n')}\n\nEVALUATION CRITERIA:\n1. ARGUMENT QUALITY: Clarity, logic, and evidence (0-4 points)\n2. REBUTTAL EFFECTIVENESS: Directly addressing opponent's points (0-3 points)\n3. COMMUNICATION: Clarity and persuasiveness (0-2 points)\n4. DEBATE ETIQUETTE: Respect and adherence to rules (0-1 point)\n\nIMPORTANT:\n- USE ONLY USERID AS KEYS, NOT DISPLAY NAMES\n- IF NO VALID ARGUMENTS, SCORE 0\n- IF INAPPROPRIATE CONTENT, SCORE 0\n- ONLY SCORE ENGLISH/HINDI/HINGLISH ARGUMENTS. NOTE THATIN MAJORITY OF CASES YOU MUST PROVIDE A CLEAR WINNER EXCEPT THE ONES MENTIONED BEFORE.`;

      // Get AI judgment
      const response = await judgeWithGroq(prompt, 'llama-3.3-70b-versatile');
      const jsonMatch = response.match(/\{[\s\S]*\}/);
      const judgment = jsonMatch ? JSON.parse(jsonMatch[0]) : null;
      
      // Get AI winner stance
      const aiWinnerId = judgment?.winner;
      const aiWinnerParticipant = latestDebateData.participants.find(p => p.userId === aiWinnerId);
      const aiWinnerStance = aiWinnerParticipant?.stance;
      // Get voting winner stance and margin
      const proVotes = latestDebateData.proVotes || 0;
      const conVotes = latestDebateData.conVotes || 0;
      let votingWinnerStance: 'pro' | 'con' | 'draw' = 'draw';
      let voteMargin = 0;
      if (proVotes > conVotes) {
        votingWinnerStance = 'pro';
        voteMargin = proVotes - conVotes;
      } else if (conVotes > proVotes) {
        votingWinnerStance = 'con';
        voteMargin = conVotes - proVotes;
      }
      // Determine final winner
      let isDraw = false;
      if (
        aiWinnerStance &&
        votingWinnerStance !== 'draw' &&
        aiWinnerStance !== votingWinnerStance &&
        voteMargin >= 10
      ) {
        isDraw = true;
      }
      // If draw, set both as winner and award 5 points each
      let finalWinnerId = aiWinnerId;
      let customJudgment = { ...judgment };
      if (isDraw) {
        finalWinnerId = null;
        customJudgment.winner = 'Draw';
        customJudgment.reasoning = 'AI and voting results differ by a margin of at least 10 votes. Declared as draw.';
        // Optionally, set scores/feedback for both
      }
      // Calculate new ratings/points
      let ratings: Record<string, number> | null = null;
      let ratingChanges: Record<string, number> | null = null;
      if (latestDebateData.ratings) {
        if (isDraw) {
          // Award both 5 points (or custom logic)
          ratings = { ...latestDebateData.ratings };
          ratingChanges = {} as Record<string, number>;
          for (const userId of Object.keys(ratings)) {
            ratingChanges[userId] = 5;
            ratings[userId] += 5;
          }
        } else if (finalWinnerId) {
          ratings = calculateDebateRatings(latestDebateData.ratings, finalWinnerId);
          ratingChanges = {} as Record<string, number>;
          for (const userId of Object.keys(ratings)) {
            const oldRating = latestDebateData.ratings[userId];
            const newRating = ratings[userId];
            ratingChanges[userId] = newRating - oldRating;
          }
        }
        // Update user ratings in Firestore
        if (ratings) {
          for (const userId of Object.keys(ratings)) {
            try {
              await updateDoc(doc(firestore, 'users', userId), {
                rating: ratings[userId]
              });
            } catch (err) {
              console.error(`Failed to update rating for user ${userId}:`, err);
            }
          }
        }
        await refreshUserData();
      }
      // Update debate with custom judgment, ratings, and rating changes
      const updatedDebate = {
        ...latestDebateData,
        status: 'completed',
        judgment: customJudgment,
        ratings,
        ratingChanges,
        endedAt: Date.now(),
        endReason: 'manual',
      };
      await updateDoc(doc(firestore, 'debates', debate.id), updatedDebate);
      setShowJudgment(true);

      // Update user stats for all participants using ratings keys
      if (ratings) {
        for (const userId of Object.keys(ratings)) {
          const userRef = doc(firestore, 'users', userId);
          const userSnap = await getDoc(userRef);
          if (!userSnap.exists()) continue;
          const userData = userSnap.data();
          let wins = userData.wins || 0;
          let losses = userData.losses || 0;
          let draws = userData.draws || 0;
          let gamesPlayed = userData.gamesPlayed || 0;
          // Determine result for this user
          let isDraw = customJudgment.winner === 'Draw' || customJudgment.winner === 'draw';
          let isWin = customJudgment.winner === userId;
          let isLoss = !isDraw && !isWin;
          if (isDraw) {
            draws += 1;
          } else if (isWin) {
            wins += 1;
          } else if (isLoss) {
            losses += 1;
          }
          gamesPlayed += 1;
          let updateObj: any = {
            wins,
            losses,
            draws,
            gamesPlayed,
            win_rate: gamesPlayed > 0 ? wins / gamesPlayed : 0,
            last_active: new Date(),
            updated_at: new Date(),
            provisionalRating: gamesPlayed >= 5 ? false : userData.provisionalRating,
            rating: ratings[userId]
          };
          await updateDoc(userRef, updateObj);
        }
      }
    } catch (error) {
      console.error('Error ending debate:', error);
      // Still end the debate even if judgment fails
      const updatedDebate = {
        ...latestDebateData,
        status: 'completed',
        endedAt: Date.now(),
        endReason: 'error',
      };
      await updateDoc(doc(firestore, 'debates', latestDebateData.id), updatedDebate);
    } finally {
      setIsJudging(false);
    }
  };

  // Handle forfeit - immediately end debate with forfeit result
  const handleForfeit = async () => {
    if (!debate || !currentUser) return;
    
    try {
      setIsJudging(true);
      
      // Find the opponent (the winner)
      const opponent = debate.participants.find(p => p.userId !== currentUser.uid);
      if (!opponent) {
        console.error('No opponent found for forfeit');
        return;
      }
      
      // Create forfeit judgment with fixed scores: opponent gets 10, current user gets 0
      const forfeitJudgment = {
        winner: opponent.userId, // Opponent wins by forfeit
        // Main scores structure (for compatibility)
        scores: {
          [opponent.userId]: 10.0,
          [currentUser.uid]: 0.0
        },
        // Main feedback structure (for compatibility)
        feedback: {
          [opponent.userId]: [
            "Won by forfeit - opponent gave up",
            "Victory achieved without completing all rounds",
            "Consider this a learning opportunity for future debates"
          ],
          [currentUser.uid]: [
            "Forfeited the debate",
            "Consider staying to complete debates for better learning",
            "Practice building stronger arguments to avoid forfeit situations"
          ]
        },
        reasoning: `Debate ended by forfeit. ${debate.participants.find(p => p.userId === currentUser.uid)?.displayName || 'Participant'} forfeited the debate, awarding victory to ${opponent.displayName || 'opponent'}.`,
        fallaciesDetected: [], // Required field - empty for forfeit
        highlights: [
          `${opponent.displayName || 'Opponent'} won by forfeit`,
          "Debate concluded before completion"
        ],
        learningPoints: [
          "Complete debates for better learning experience",
          "Build stronger arguments to avoid forfeit situations",
          "Practice debate endurance and persistence"
        ],
        endReason: 'forfeit', // Mark this as a forfeit ending
        forfeitedBy: currentUser.uid // Track who forfeited
      };

      // Calculate new ratings only if this is a 1v1 debate (exactly 2 participants)
      let ratings: Record<string, number> | null = null;
      let ratingChanges: Record<string, number> | null = null;
      
      if (debate.participants.length === 2) {
        console.log('[DEBUG] Forfeit: Calculating ELO ratings for 1v1 debate');
        try {
          // Fetch current ratings for both participants if not available in debate
          let currentRatings = debate.ratings;
          if (!currentRatings) {
            console.log('[DEBUG] Forfeit: No ratings in debate object, fetching from Firestore');
            currentRatings = {};
            for (const participant of debate.participants) {
              try {
                const userDoc = await getDoc(doc(firestore, 'users', participant.userId));
                if (userDoc.exists()) {
                  const userData = userDoc.data();
                  currentRatings[participant.userId] = userData.rating || 1200;
                } else {
                  currentRatings[participant.userId] = 1200; // Default rating
                }
              } catch (error) {
                console.error(`[DEBUG] Forfeit: Failed to fetch rating for ${participant.userId}:`, error);
                currentRatings[participant.userId] = 1200; // Default rating
              }
            }
          }

          // Calculate new ratings based on forfeit (winner gets full rating gain)
          ratings = calculateDebateRatings(currentRatings, opponent.userId);
          ratingChanges = {} as Record<string, number>;
          for (const userId of Object.keys(ratings)) {
            const oldRating = currentRatings[userId];
            const newRating = ratings[userId];
            ratingChanges[userId] = newRating - oldRating;
          }
          console.log('[DEBUG] Forfeit: Calculated ratings:', { ratings, ratingChanges });
        } catch (error) {
          console.error('[DEBUG] Forfeit: Error calculating ratings:', error);
          // Continue without rating changes if calculation fails
        }
      }

      // Update debate with forfeit result
      const updatedDebate = {
        ...debate,
        status: 'completed',
        endedAt: Date.now(),
        judgment: forfeitJudgment,
        endReason: 'forfeit',
        forfeitedBy: currentUser.uid,
        ...(ratings && { ratings }),
        ...(ratingChanges && { ratingChanges })
      };

      await updateDoc(doc(firestore, 'debates', debate.id), updatedDebate);

      // Update user stats for all participants
      if (debate.participants && Array.isArray(debate.participants)) {
        for (const participant of debate.participants) {
          const userRef = doc(firestore, 'users', participant.userId);
          await runTransaction(firestore, async (transaction) => {
            const userSnap = await transaction.get(userRef);
            if (!userSnap.exists()) return;
            
            const userData = userSnap.data();
            let wins = userData.wins || 0;
            let losses = userData.losses || 0;
            let draws = userData.draws || 0;
            let gamesPlayed = userData.gamesPlayed || 0;
            let rating = userData.rating || 1200;

            // Determine result for this participant
            if (participant.userId === opponent.userId) {
              // This participant won by forfeit
              wins += 1;
              gamesPlayed += 1;
            } else {
              // This participant lost by forfeit
              losses += 1;
              gamesPlayed += 1;
            }

            // Update rating if calculated
            if (ratings && ratings[participant.userId] !== undefined) {
              rating = ratings[participant.userId];
            }

            // Calculate win_rate
            const win_rate = gamesPlayed > 0 ? wins / gamesPlayed : 0;
            
            // Update provisional rating status
            let provisionalRating = userData.provisionalRating;
            if (gamesPlayed >= 5) provisionalRating = false;

            const updateObj = {
              wins,
              losses,
              draws,
              gamesPlayed,
              win_rate,
              last_active: new Date(),
              updated_at: new Date(),
              provisionalRating,
              rating
            };

            transaction.update(userRef, updateObj);
          });
        }
      }

      console.log('[DEBUG] Forfeit: Debate ended successfully');
    } catch (error) {
      console.error('Error forfeiting debate:', error);
    } finally {
      setIsJudging(false);
    }
  };

  // Auto end debate after MAX_ROUNDS
  useEffect(() => {
    if (!debate) return;
    if (debate.currentRound > MAX_ROUNDS && debate.status === 'active') {
      console.log('[DEBUG] UsersDebateRoom: Max rounds exceeded, ending debate');
      // Add a small delay to avoid race conditions with argument submission
      setTimeout(() => {
        handleEndDebate();
      }, 100);
    }
  }, [debate]);

  // Determine if current user is a debater
  const isDebater = debate?.participants.some(p => p.userId === currentUser?.uid);

  // Voting handler
  const handleVote = async (vote: 'pro' | 'con') => {
    if (!debate || !currentUser || isDebater || hasVoted) return;
    const debateRef = doc(firestore, 'debates', debate.id);
    try {
      await updateDoc(debateRef, {
        [vote === 'pro' ? 'proVotes' : 'conVotes']: (debate[vote === 'pro' ? 'proVotes' : 'conVotes'] || 0) + 1
      });
      setHasVoted(true);
      localStorage.setItem(`debate_voted_${debate.id}_${currentUser.uid}`, '1');
    } catch (e) {
      console.error('Failed to vote:', e);
    }
  };
  // On mount, check if user has already voted
  useEffect(() => {
    if (debate && currentUser) {
      setHasVoted(!!localStorage.getItem(`debate_voted_${debate.id}_${currentUser.uid}`));
    }
  }, [debate, currentUser]);

  // Copy to clipboard handler
  const handleCopyShare = () => {
    if (!debate || !currentUser) return;
    const opponent = debate.participants.find(p => p.userId !== currentUser.uid);
    const shareMsg = `Hey there! I'm having a debate on "${debate.topic}" with ${opponent?.displayName || 'an opponent'}. Join this debate to support me in favor (pro) or against (con) the topic.\nDebate link: ${window.location.href}`;
    navigator.clipboard.writeText(shareMsg);
    setCopySuccess(true);
    setTimeout(() => setCopySuccess(false), 2000);
  };

  // Loading state
  if (isLoading) {
    console.log('[DEBUG] UsersDebateRoom: Rendering loading state');
    return (
      <div className="min-h-screen flex items-center justify-center bg-black text-white">
        <div className="text-center">
          <div className="text-2xl font-bold mb-4">Loading Debate...</div>
          <LoadingSpinner size="lg" />
          <div className="mt-4 text-gray-400">
            {roomId ? `Debate ID: ${roomId}` : 'No debate ID provided'}
          </div>
        </div>
      </div>
    );
  }

  // Error state
  if (error || !debate) {
    console.log('[DEBUG] UsersDebateRoom: Rendering error state', { error, debate: !!debate });
    return (
      <div className="min-h-screen flex items-center justify-center bg-black text-white">
        <div className="text-center">
          <div className="text-2xl font-bold mb-4">Debate Not Found</div>
          <div className="text-gray-400 mb-4">{error || 'The debate you are looking for does not exist.'}</div>
          <Button onClick={() => navigate('/find-debate')}>
            Find New Debate
          </Button>
        </div>
      </div>
    );
  }

  const myParticipant = debate.participants.find(p => p.userId === currentUser?.uid);
  const otherParticipant = debate.participants.find(p => p.userId !== currentUser?.uid);
  const canSubmit = isMyTurn && !isSubmitting && debate.status === 'active' && debate.currentRound <= MAX_ROUNDS;
  const isDebateCompleted = debate.status === 'completed';
  
  // Debug logging
  console.log('[DEBUG] UsersDebateRoom: Debate status:', debate.status);
  console.log('[DEBUG] UsersDebateRoom: Current round:', debate.currentRound);
  console.log('[DEBUG] UsersDebateRoom: Is debate completed:', isDebateCompleted);
  console.log('[DEBUG] UsersDebateRoom: Is my turn:', isMyTurn);
  console.log('[DEBUG] UsersDebateRoom: Participant details:', participantDetails);
  console.log('[DEBUG] UsersDebateRoom: My participant:', myParticipant);
  console.log('[DEBUG] UsersDebateRoom: Other participant:', otherParticipant);
  console.log('[DEBUG] UsersDebateRoom: Current user:', currentUser);

  // Helper to get score for a participant
  const getScore = (judgment: any, participant: any): number | null => {
    if (!judgment) return null;
    if (judgment.scores?.[participant.userId] !== undefined) return judgment.scores[participant.userId];
    if (judgment.scores?.[participant.displayName] !== undefined) return judgment.scores[participant.displayName];
    return null;
  };
  // Helper to get feedback for a participant
  const getFeedback = (judgment: any, participant: any): string[] => {
    if (!judgment) return [];
    return (
      judgment.feedback?.[participant.userId] ||
      judgment.feedback?.[participant.displayName] ||
      []
    );
  };

  const votingWinnerLabel = (() => {
    const proVotes = debate?.proVotes || 0;
    const conVotes = debate?.conVotes || 0;
    if (proVotes > conVotes) return 'Pro';
    if (conVotes > proVotes) return 'Con';
    return 'Draw';
  })();

  return (
    <div className="relative min-h-screen w-full flex flex-col bg-black text-white select-none">
      {/* Always show header at the top */}
      <div className="w-full flex items-center justify-between px-6 py-4 bg-black/80 border-b border-gray-800" style={{position: 'sticky', top: 0, left: 0, zIndex: 50}}>
        <div className="flex items-center gap-4">
          <div className="text-lg font-bold max-w-[70vw] leading-tight break-words" title={debate?.topic || 'Loading...'}>{debate?.topic || 'Loading...'}</div>
          {/* Round Counter */}
          {debate && (
            <div className="flex items-center gap-2 text-sm text-gray-400">
              <RotateCcw className="w-4 h-4" />
              <span>Round {debate.currentRound}/{MAX_ROUNDS}</span>
            </div>
          )}
          {/* Timer */}
          {!isDebateCompleted && debate?.status === 'active' && (
            <div className="flex items-center gap-2">
              <Clock className={`w-4 h-4 ${isMyTurn ? 'text-orange-400' : 'text-gray-400'}`} />
              <span className={`text-sm font-medium ${isMyTurn ? 'text-orange-400' : 'text-gray-400'}`}>
                {isMyTurn ? `${timeLeft}s` : 'Waiting...'}
              </span>
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
      
      {/* Participants Info Bar */}
      {debate && (
        <div className="w-full bg-[#0a0a0a] border-b border-gray-800 px-6 py-3">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-6">
              {/* Opponent (Left Side) */}
              <div className="flex items-center gap-3">
                <img
                  src={otherParticipant?.stance === 'pro' ? '/pro-left.png' : '/con-left.png'}
                  alt={otherParticipant?.displayName}
                  className="w-8 h-8 object-contain rounded-full border border-gray-600"
                />
                <div className="text-sm">
                  <div className="font-semibold text-white">
                    {otherParticipant?.displayName}
                  </div>
                  <div className="text-gray-400 text-xs">
                    {otherParticipant?.stance?.toUpperCase() || 'UNKNOWN'}
                  </div>
                </div>
              </div>
              {/* VS Separator */}
              <div className="text-gray-500 text-sm font-medium">VS</div>
              {/* Current User (Right Side) */}
              <div className="flex items-center gap-3">
                <div className="text-sm text-right">
                  <div className="font-semibold text-white">
                    <span className="font-bold text-green-400">{myParticipant?.displayName}</span>
                  </div>
                  <div className="text-gray-400 text-xs">
                    {myParticipant?.stance?.toUpperCase() || 'UNKNOWN'}
                  </div>
                </div>
                <img
                  src={myParticipant?.stance === 'pro' ? '/pro-right.png' : '/con-right.png'}
                  alt={myParticipant?.displayName}
                  className="w-8 h-8 object-contain rounded-full border border-gray-600"
                />
              </div>
            </div>
            {/* Current Turn Indicator */}
            {!isDebateCompleted && debate?.status === 'active' && (
              <div className="flex items-center gap-2 text-sm">
                <div className={`w-2 h-2 rounded-full ${isMyTurn ? 'bg-green-400 animate-pulse' : 'bg-gray-400'}`}></div>
                <span className="text-gray-400">
                  {isMyTurn ? 'Your turn' : `${otherParticipant?.displayName}'s turn`}
                </span>
              </div>
            )}
          </div>
        </div>
      )}
      
      {/* Main chat area with WhatsApp-like layout */}
      <div className="flex-1 flex flex-col justify-end px-2 md:px-8 py-6 overflow-y-auto scrollbar-fade" ref={debateContainerRef} style={{height: 'calc(100vh - 160px)'}}>
        {isJudging && (
          <div className="fixed inset-0 z-50 flex flex-col items-center justify-center bg-black bg-opacity-80">
            <div className="w-64 h-2 bg-gray-700 rounded-full overflow-hidden mb-6">
              <div className="h-full bg-gradient-to-r from-blue-400 to-blue-600 animate-pulse" style={{ width: '100%' }}></div>
            </div>
            <div className="text-white text-lg font-semibold">Your debate is being evaluated...</div>
          </div>
        )}
        {debate?.arguments.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full text-gray-400">
            <MessageSquare className="w-12 h-12 mb-4 text-gray-600" />
            <p className="text-lg font-medium">No arguments yet. Be the first to strike! ⚔️</p>
            <p className="text-sm text-gray-500 mt-2">Start the debate with a powerful opening argument</p>
          </div>
        ) : (
          <>
            {/* Render chat arguments */}
            {debate.arguments.map((arg, idx) => {
              const participant = debate.participants.find(p => p.userId === arg.userId) || myParticipant;
              const isPro = participant?.stance === 'pro';
              const isCon = participant?.stance === 'con';
              const isMine = arg.userId === currentUser?.uid;
            
              const avatarSrc = isMine ? (isPro ? '/pro-right.png' : '/con-right.png') : (isCon ? '/con-left.png' : '/pro-left.png');
              
              // Alignment: current user always on right, opponent always on left
              const alignment = isMine ? 'justify-end' : 'justify-start';
              const bubbleAlign = isMine ? 'flex-row-reverse' : 'flex-row';
              
              return (
                <div
                  key={arg.id}
                  className={`w-full flex ${alignment} mb-2`}
                >
                  <div className={`flex ${bubbleAlign} items-end gap-3`} style={{maxWidth: '80%'}}>
                    {/* Even Larger Avatar */}
                    <img
                      src={avatarSrc}
                      alt={participantDetails[arg.userId]?.displayName}
                      className="w-40 h-52 object-contain rounded-3xl border-2 border-gray-700 bg-black shadow-md"
                      style={{minWidth: 160, minHeight: 208}}
                    />
                    {/* Bubble */}
                    <div
                      className={`rounded-2xl px-5 py-3 shadow-lg text-base whitespace-pre-line break-words
                        ${isMine ? (isPro ? 'bg-[#1a1a1a] text-green-200 border-r-4 border-green-500' : 'bg-[#181a22] text-red-200 border-l-4 border-red-500') : (isCon ? 'bg-[#181a22] text-red-200 border-l-4 border-red-500' : 'bg-[#1a1a1a] text-green-200 border-r-4 border-green-500')}
                      `}
                      style={{minWidth: '0', flex: 1}}
                    >
                      <div className="flex items-center gap-2 mb-1">
                        <span className="font-bold text-sm">
                          {participant?.userId && participantDetails[participant.userId]?.displayName 
                            ? participantDetails[participant.userId].displayName 
                            : (participant?.displayName || 'Unknown User')}
                        </span>
                        <Badge variant={isPro ? 'success' : 'error'} className="text-xs">
                          {participant?.stance?.toUpperCase()}
                        </Badge>
                        <span className="text-xs text-gray-400">Round {arg.round}</span>
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
          </>
        )}
      </div>
      
      {/* Input area - show voting for visitors, argument input for debaters */}
      <div className="w-full bg-gradient-to-b from-gray-900 to-gray-950 border-t border-gray-800 px-2 md:px-8 py-4 flex flex-col gap-0 sticky bottom-0 z-20" style={{boxShadow: '0 -2px 16px 0 #0008'}}>
      {!isDebater ? (
  // Voting UI for non-debaters
  <div className="flex flex-col items-center gap-4">
    {!hasVoted && debate?.status === 'active' ? (
      // Show voting buttons if user hasn't voted and debate is active
      <>
        <div className="text-gray-300 text-sm font-medium">Vote for the winning side:</div>
        <div className="flex justify-center gap-4 w-full">
          <Button
            onClick={() => handleVote('pro')}
            className="px-6 py-3 rounded-xl font-semibold bg-gradient-to-r from-green-500 to-emerald-600 text-white hover:from-green-600 hover:to-emerald-700 shadow-lg hover:shadow-xl hover:scale-105 transform transition-all duration-300"
          >
            👍 Vote Pro
          </Button>
          <Button
            onClick={() => handleVote('con')}
            className="px-6 py-3 rounded-xl font-semibold bg-gradient-to-r from-red-500 to-pink-600 text-white hover:from-red-600 hover:to-pink-700 shadow-lg hover:shadow-xl hover:scale-105 transform transition-all duration-300"
          >
            👎 Vote Con
          </Button>
        </div>
      </>
    ) : hasVoted && debate?.status === 'active' ? (
      // Show vote submitted message if user has voted but debate hasn't ended
      <div className="text-center">
        <div className="text-green-400 text-lg font-semibold mb-2">
          ✅ Vote Submitted!
        </div>
        <div className="text-gray-300 text-sm">
          Thanks for voting! Your vote has been recorded.
        </div>
      </div>
    ) : debate?.status === 'completed' ? (
      // Show debate ended message if debate has completed
      <div className="text-center">
        <div className="text-gray-400 text-lg font-semibold mb-2">
          🏁 Debate Has Ended
        </div>
        <div className="text-gray-300 text-sm">
          Check the results below to see who won!
        </div>
      </div>
    ) : null}
  </div>
) : (
          // Original input area for debaters
          <>
            {/* Drag handle */}
            <div 
              ref={dragHandleRef}
              className="flex justify-center py-2 cursor-ns-resize hover:bg-gray-800/50 transition-colors"
              onMouseDown={(e) => {
                draggingRef.current = true;
                lastYRef.current = e.clientY;
              }}
            >
              <div className="w-16 h-1.5 rounded bg-gray-700" />
            </div>
            <div className="flex items-center gap-3">
          {/* Clipboard icon on the left */}
          <button
            onClick={handleCopyShare}
            type="button"
            title="Copy debate invite"
            className={`p-2 rounded-lg transition-colors duration-200 border-none outline-none focus:ring-2 focus:ring-green-400 ${copySuccess ? 'bg-green-600 text-white' : 'bg-gray-800 text-gray-400 hover:bg-gray-700 hover:text-white'}`}
            style={{ display: 'flex', alignItems: 'center', justifyContent: 'center' }}
          >
            <Clipboard className={`w-6 h-6 ${copySuccess ? 'text-white' : ''}`} />
          </button>
          {/* Forfeit button */}
          <Button
            onClick={handleForfeit}
            disabled={!debate || isSubmitting || isDebateCompleted || debate.participants.length < 2}
            className={`px-6 py-2 rounded-xl font-semibold transition-all duration-300 flex items-center gap-2 bg-gradient-to-r from-red-600 to-red-700 text-white hover:from-red-700 hover:to-red-800 shadow-lg hover:shadow-xl mr-2 ${isDebateCompleted || debate.participants.length < 2 ? 'opacity-60 cursor-not-allowed' : ''}`}
            title="Forfeit Debate - Immediately lose and end the debate"
          >
            <X className="w-5 h-5" />
          </Button>
          {/* End Debate button on the left */}
          <Button
            onClick={handleEndDebate}
            disabled={!debate || isSubmitting || isDebateCompleted || (debate && debate.currentRound <= MAX_ROUNDS)}
            className={`px-6 py-2 rounded-xl font-semibold transition-all duration-300 flex items-center gap-2 bg-gradient-to-r from-orange-500 to-red-500 text-white hover:from-orange-600 hover:to-red-600 shadow-lg hover:shadow-xl mr-2 ${isDebateCompleted || (debate && debate.currentRound <= MAX_ROUNDS) ? 'opacity-60 cursor-not-allowed' : ''}`}
            title={debate && debate.currentRound <= MAX_ROUNDS ? 'The debate can only be ended after completion of all rounds' : 'End Debate'}
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
            placeholder={isDebateCompleted ? 'Debate has ended.' : isMyTurn ? 'Type your argument...' : 'Waiting for your turn...'}
            disabled={!isMyTurn || isSubmitting || isDebateCompleted || isTranscribing}
            className={`flex-1 rounded-xl px-4 py-3 text-base border-2 focus:ring-2 transition-all duration-200
              ${isMyTurn && !isDebateCompleted ? 'border-green-500 focus:ring-green-600' : 'border-gray-600'}
              bg-gray-900 text-white placeholder-gray-400
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
          </>
        )}
      </div>

      {/* After the chat area, but before the modals, add a new section for winner and scores if debate is completed and judgment is present */}
      {isDebateCompleted && debate?.judgment && (() => {
        const judgment = debate.judgment;
        // Winner: try userId, then displayName
        let winnerId = judgment.winner;
        let winnerParticipant = debate.participants.find(
          p => p.userId === winnerId || p.displayName === winnerId
        );
        let winnerName = winnerParticipant?.displayName || winnerId || "No winner";
        // Scores: robust mapping
        const getScore = (uid: string) => {
          if (judgment.scores?.[uid] !== undefined) return judgment.scores[uid];
          // Try to find by displayName if not found by userId
          const participant = debate.participants.find(p => p.displayName === uid);
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
              {debate.participants.map((participant) => {
                const score = getScore(participant.userId) ?? getScore(participant.displayName);
                const ratingChange = debate.ratingChanges?.[participant.userId] || 0;
                const isCurrentUser = participant.userId === currentUser?.uid;
                return (
                  <div key={participant.userId} className="flex-1 bg-[#101014] rounded-xl p-4 border border-gray-800">
                    <div className="font-semibold text-lg mb-1 flex items-center justify-between">
                      <span>{participant.displayName}</span>
                      {isCurrentUser && (
                        <div className={`text-sm font-medium px-2 py-1 rounded ${
                          ratingChange > 0 ? 'bg-green-900 text-green-300' : 
                          ratingChange < 0 ? 'bg-red-900 text-red-300' : 
                          'bg-gray-700 text-gray-300'
                        }`}>
                          {ratingChange > 0 ? '+' : ''}{ratingChange} ELO
                        </div>
                      )}
                    </div>
                    <div className="text-2xl font-bold text-blue-400 mb-2">
                      {typeof score === 'number' ? score.toFixed(1) + '/10' : 'No score returned by judge'}
                    </div>
                    <ul className="text-sm text-gray-300 list-disc pl-5">
                      {(judgment.feedback?.[participant.userId] || judgment.feedback?.[participant.displayName] || []).map((fb: string, i: number) => (
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
      {/* Move the voting info box to just below the results section (winner and scores) */}
      {isDebateCompleted && (
        <div className="flex justify-center mt-2">
          <div className="bg-gray-900 border border-gray-700 rounded-lg px-6 py-3 flex flex-col items-center gap-2">
            <div className="flex gap-6">
              <span className="text-green-400 font-bold">Pro votes: {debate?.proVotes || 0}</span>
              <span className="text-red-400 font-bold">Con votes: {debate?.conVotes || 0}</span>
            </div>
            <div className="text-sm text-gray-300 mt-1">
              Voting winner: {votingWinnerLabel}
            </div>
          </div>
        </div>
      )}
      {/* Modals, overlays, and toasts remain unchanged below */}

      {/* Judgment Modal */}
      <Modal
        open={showJudgment}
        onClose={() => setShowJudgment(false)}
      >
        <div className="p-6 max-h-[80vh] overflow-y-auto bg-white dark:bg-gray-900 text-gray-900 dark:text-white">
          {debate.judgment && (() => {
            const judgment = debate.judgment as typeof debate.judgment & { learningPoints?: string[] };
            // Winner: try userId, then displayName
            let winnerId = judgment.winner;
            let winnerParticipant = debate.participants.find(
              p => p.userId === winnerId || p.displayName === winnerId
            );
            let winnerName = winnerParticipant?.displayName || winnerId || "No winner";
            // Scores: robust mapping
            const getScore = (uid: string) => {
              if (judgment.scores?.[uid] !== undefined) return judgment.scores[uid];
              // Try to find by displayName if not found by userId
              const participant = debate.participants.find(p => p.displayName === uid);
              if (participant && judgment.scores?.[participant.userId] !== undefined) {
                return judgment.scores[participant.userId];
              }
              return null;
            };
            return (
              <>
                <h3 className="text-lg font-semibold mb-4 text-gray-900 dark:text-white">🏆 Debate Results</h3>
                <div className="mb-4">
                  <div className="text-xl font-bold text-green-600 dark:text-green-400 mb-2">Winner: {winnerName}</div>
                  <div className="text-gray-700 dark:text-gray-300 mb-4">{judgment.reasoning}</div>
                </div>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-4">
                  {debate.participants.map((participant) => {
                    const score = getScore(participant.userId) ?? getScore(participant.displayName);
                    const ratingChange = debate.ratingChanges?.[participant.userId] || 0;
                    const isCurrentUser = participant.userId === currentUser?.uid;
                    return (
                      <div key={participant.userId} className="bg-gray-50 dark:bg-gray-800 rounded-lg p-4 border border-gray-200 dark:border-gray-700">
                        <div className="font-semibold text-lg mb-1 text-gray-900 dark:text-white flex items-center justify-between">
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
                        </div>
                        <div className="text-2xl font-bold text-blue-600 dark:text-blue-400 mb-2">
                          {typeof score === 'number' ? score.toFixed(1) + '/10' : 'No score returned by judge'}
                        </div>
                        <ul className="text-sm text-gray-600 dark:text-gray-300 list-disc pl-5">
                          {(judgment.feedback?.[participant.userId] || judgment.feedback?.[participant.displayName] || []).map((fb: string, i: number) => (
                            <li key={i}>{fb}</li>
                          ))}
                        </ul>
                      </div>
                    );
                  })}
                </div>
                {judgment.learningPoints && judgment.learningPoints.length > 0 && (
                  <div className="mb-4">
                    <h4 className="font-semibold mb-2 text-gray-900 dark:text-white">💡 Key Learning Points</h4>
                    <ul className="list-disc pl-5 text-gray-700 dark:text-gray-300">
                      {judgment.learningPoints.map((point: string, i: number) => (
                        <li key={i}>{point}</li>
                      ))}
                    </ul>
                  </div>
                )}
                {judgment.highlights && judgment.highlights.length > 0 && (
                  <div className="mb-4">
                    <h4 className="font-semibold mb-2 text-gray-900 dark:text-white">✨ Debate Highlights</h4>
                    <ul className="list-disc pl-5 text-gray-700 dark:text-gray-300">
                      {judgment.highlights.map((highlight: string, idx: number) => (
                        <li key={idx}>{highlight}</li>
                      ))}
                    </ul>
                  </div>
                )}
                <Button
                  onClick={() => setShowJudgment(false)}
                  className="w-full mt-4 bg-blue-600 hover:bg-blue-700 text-white"
                >
                  Close
                </Button>
              </>
            );
          })()}
        </div>
      </Modal>
    </div>
  );
};

export default UsersDebateRoom;
