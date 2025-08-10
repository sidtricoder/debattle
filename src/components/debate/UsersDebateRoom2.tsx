import React, { useState, useEffect, useRef } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { onSnapshot, doc, updateDoc, arrayUnion, getDoc, increment, runTransaction } from 'firebase/firestore';
import { firestore } from '../../lib/firebase';
import { useAuthStore } from '../../stores/authStore';
import { useDebateStore } from '../../stores/debateStore';
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
  Clipboard,
  X
} from 'lucide-react';

// Constants for user vs user debates
// Remove hardcoded constants
// const MAX_ROUNDS = 5;
// const TURN_TIME_SECONDS = 60;

/*
NEW ROUND-ROBIN SYSTEM:
- Each round, one participant from each team speaks
- Multiple participants per team rotate across rounds
- Example: PRO team has A,B and CON team has C
  Round 1: A (PRO) vs C (CON)
  Round 2: B (PRO) vs C (CON)  
  Round 3: A (PRO) vs C (CON)
- Timer is visible to all participants
- Arguments are tagged with the round number
*/

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
  joinedAt?: number;
}

interface Debate {
  id: string;
  topic: string;
  participants: DebateParticipant[];
  arguments: DebateArgument[];
  status: 'waiting' | 'active' | 'completed';
  currentTurn: string; // userId of current turn
  currentRound: number;
  currentTeam: 'pro' | 'con'; // which team's turn it is
  turnOrder: string[]; // cyclical turn order of userIds
  judgment?: any;
  ratings?: Record<string, number>;
  ratingChanges?: Record<string, number>;
  createdAt: Date;
  // proVotes?: number;
  // conVotes?: number;
  customSettings?: {
    rounds?: number;
    timePerUser?: number;
    aiModel?: string;
    userStance?: 'pro' | 'con';
  };
}

export const UsersDebateRoom: React.FC = () => {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { user: currentUser, refreshUserData } = useAuthStore();
  const { joinDebate, endDebate } = useDebateStore();
  
  // State
  const [debate, setDebate] = useState<Debate | null>(null);
  const [argument, setArgument] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [showStanceModal, setShowStanceModal] = useState(false);
  const [selectedStance, setSelectedStance] = useState<'pro' | 'con'>('pro');
  // Use customSettings for timer and rounds if present
  const maxRounds = debate?.customSettings?.rounds || 5;
  const turnTimeSeconds = debate?.customSettings?.timePerUser || 60;
  const aiModel = debate?.customSettings?.aiModel || 'gemini';
  const userStance = debate?.customSettings?.userStance || 'pro';
  const [timeLeft, setTimeLeft] = useState(turnTimeSeconds);
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
  // const [hasVoted, setHasVoted] = useState<boolean>(false);

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
    if (!id) {
      console.log('[DEBUG] UsersDebateRoom: No id provided');
      setError('No debate ID in URL.');
      setIsLoading(false);
      return;
    }

    console.log('[DEBUG] UsersDebateRoom: Subscribing to debate with Firestore ID:', id);
    setIsLoading(true);
    setError(null);

    const unsub = onSnapshot(
      doc(firestore, 'debates', id),
      async (docSnap) => {
        console.log('[DEBUG] UsersDebateRoom: onSnapshot callback triggered');
        console.log('[DEBUG] UsersDebateRoom: docSnap.exists():', docSnap.exists());
        console.log('[DEBUG] UsersDebateRoom: docSnap.id:', docSnap.id);

        if (docSnap.exists()) {
          const rawData = docSnap.data();
          console.log('[DEBUG] UsersDebateRoom: Raw Firestore data:', rawData);

          const debateData = { id: docSnap.id, ...rawData } as Debate;
          console.log('[DEBUG] UsersDebateRoom: Parsed debate data:', debateData);

          // Initialize current turn if missing or incomplete
          if (debateData.participants && debateData.participants.length > 0) {
            let shouldUpdate = false;
            let updateData: any = {};
            
            // Initialize currentRound if missing
            if (!debateData.currentRound || debateData.currentRound < 1) {
              debateData.currentRound = 1;
              updateData.currentRound = 1;
              shouldUpdate = true;
            }
            
            // Set current turn based on round-robin system if missing or if both teams are present
            const proUsers = debateData.participants.filter(p => p.stance === 'pro');
            const conUsers = debateData.participants.filter(p => p.stance === 'con');
            
            if (proUsers.length > 0 && conUsers.length > 0) {
              // Both teams are present, ensure proper turn management
              const currentRound = debateData.currentRound || 1;
              
              if (!debateData.currentTurn || !debateData.currentTeam) {
                // Initialize with first pro speaker for round 1
                const proSpeaker = proUsers[(currentRound - 1) % proUsers.length];
                debateData.currentTurn = proSpeaker.userId;
                debateData.currentTeam = 'pro';
                updateData.currentTurn = proSpeaker.userId;
                updateData.currentTeam = 'pro';
                shouldUpdate = true;
                console.log('[DEBUG] Initializing first speaker:', proSpeaker.userId, 'for round', currentRound);
              }
            }
            
            if (shouldUpdate) {
              try {
                await updateDoc(doc(firestore, 'debates', id), updateData);
                // Update local data
                Object.assign(debateData, updateData);
              } catch (error) {
                console.error('[DEBUG] Failed to update debate initialization:', error);
              }
            }
          }

          setDebate(debateData);
          createParticipantDetails(debateData.participants || []);

          // Check if current user is a participant
          const isParticipant = debateData.participants?.some(p => p.userId === currentUser?.uid);
          console.log('[DEBUG] UsersDebateRoom: Is participant?', isParticipant);

          if (!isParticipant && debateData.status === 'waiting') {
            setShowStanceModal(true);
          }

          // Show judgment if debate is completed
          if (debateData.status === 'completed' && debateData.judgment) {
            setShowJudgment(true);
            setShowWinner(true);
          }

          // Check if it's the current user's turn
          const myTurn = debateData.currentTurn === currentUser?.uid && debateData.status === 'active';
          setIsMyTurn(myTurn);
          console.log('[DEBUG] UsersDebateRoom: Is my turn?', myTurn, 'Current turn:', debateData.currentTurn, 'My UID:', currentUser?.uid);

          setIsLoading(false);
        } else {
          console.log('[DEBUG] UsersDebateRoom: Document does not exist');
          setError('Debate not found');
          setIsLoading(false);
        }
      },
      (error) => {
        console.error('[DEBUG] UsersDebateRoom: onSnapshot error:', error);
        setError('Failed to load debate');
        setIsLoading(false);
      }
    );

    return () => {
      console.log('[DEBUG] UsersDebateRoom: Cleaning up subscription');
      unsub();
    };
  }, [id]);

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
    if (!debate || !currentUser || debate.status !== 'waiting' || !hasBothTeams(debate)) return;
    
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

  // Auto-join debate on mount if not already a participant
  useEffect(() => {
    if (id && currentUser && debate) {
      const alreadyParticipant = debate.participants.some(p => p.userId === currentUser.uid);
      if (!alreadyParticipant) {
        // Show stance selection modal for new users
        setShowStanceModal(true);
      }
    }
  }, [id, currentUser, debate]);

  // Handle stance selection and join debate
  const handleJoinWithStance = async (stance: 'pro' | 'con') => {
    if (!id || !currentUser) return;
    
    try {
      console.log(`[DEBUG] Attempting to join debate ${id} as ${stance} (${currentUser.uid})`);
      await joinDebate(id, currentUser.uid, stance);
      console.log('[DEBUG] joinDebate successful');
      setShowStanceModal(false);
      
      // Always update turn order to include all participants
      if (debate) {
        const updatedParticipants = [...debate.participants, {
          userId: currentUser.uid,
          displayName: currentUser.displayName || currentUser.email || 'Unknown',
          stance,
          joinedAt: Date.now()
        }];
        
        // Get updated participant lists
        const proUsers = updatedParticipants.filter(p => p.stance === 'pro');
        const conUsers = updatedParticipants.filter(p => p.stance === 'con');
        
        // Set first speaker from pro team for round 1
        const firstProSpeaker = proUsers.length > 0 ? proUsers[0] : null;
        
        console.log('[DEBUG] Updated participants:', updatedParticipants);
        console.log('[DEBUG] Pro users:', proUsers);
        console.log('[DEBUG] Con users:', conUsers);
        console.log('[DEBUG] First speaker:', firstProSpeaker);
        
        await updateDoc(doc(firestore, 'debates', id), {
          currentTeam: 'pro', // Start with pro team
          currentTurn: firstProSpeaker?.userId || '',
          currentRound: 1, // Initialize to round 1
        });
      }
    } catch (err) {
      console.error('Failed to join debate:', err);
    }
  };

  // Determine if it's my turn
  useEffect(() => {
    if (!debate || !currentUser) return;
    setIsMyTurn(debate.currentTurn === currentUser.uid && hasBothTeams(debate));
    
    if (debate.currentTurn === currentUser.uid && argumentInputRef.current) {
      argumentInputRef.current.focus();
    }
  }, [debate, currentUser]);

  // Helper function to check if both teams have participants
  const hasBothTeams = (debate: Debate | null): boolean => {
    if (!debate) return false;
    const proCount = debate.participants.filter(p => p.stance === 'pro').length;
    const conCount = debate.participants.filter(p => p.stance === 'con').length;
    return proCount > 0 && conCount > 0;
  };

  // Get current speaker info
  const getCurrentSpeaker = () => {
    if (!debate || !debate.currentTurn) return null;
    const speaker = debate.participants.find(p => p.userId === debate.currentTurn);
    if (!speaker) return null;
    
    const speakerDetails = participantDetails[speaker.userId];
    return {
      ...speaker,
      displayName: speakerDetails?.displayName || speaker.displayName || 'Unknown'
    };
  };

  // Timer logic - visible to all participants, runs only for current speaker
  useEffect(() => {
    // Check if both teams have participants before starting timer
    if (!debate || debate.status !== 'active' || !hasBothTeams(debate)) {
      if (timerRef.current) {
        clearInterval(timerRef.current);
        timerRef.current = null;
      }
      setTimeLeft(turnTimeSeconds);
      return;
    }

    // Reset timer when turn changes
    setTimeLeft(turnTimeSeconds);
    
    // Clear any existing timer
    if (timerRef.current) clearInterval(timerRef.current);
    
    // Only the current speaker's browser actually runs the countdown
    if (isMyTurn) {
      timerRef.current = setInterval(() => {
        setTimeLeft((prev) => {
          if (prev <= 1) {
            clearInterval(timerRef.current!);
            handleAutoSubmit();
            
            // If this was the last round, end the debate
            if (debate.currentRound > maxRounds) {
              console.log('[DEBUG] UsersDebateRoom: Timer expired on last round, ending debate');
              setTimeout(() => handleEndDebate(), 1000); // Small delay to allow auto-submit to complete
            }
            
            return 0;
          }
          return prev - 1;
        });
      }, 1000);
    } else {
      // For non-current speakers, start a simulated countdown for display purposes
      timerRef.current = setInterval(() => {
        setTimeLeft((prev) => {
          if (prev <= 1) {
            clearInterval(timerRef.current!);
            return 0;
          }
          return prev - 1;
        });
      }, 1000);
    }
    
    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, [isMyTurn, debate?.currentTurn, debate?.status, debate?.participants, turnTimeSeconds]);

  // Update timer when turnTimeSeconds or currentTurn changes - visible to all
  useEffect(() => {
    if (debate && hasBothTeams(debate) && debate.status === 'active') {
      setTimeLeft(turnTimeSeconds);
    }
  }, [turnTimeSeconds, debate?.currentTurn, debate?.participants, debate?.status]);


  // Helper function to get current round participant for each team
  const getCurrentRoundParticipant = (team: 'pro' | 'con', round: number) => {
    const teamParticipants = debate?.participants.filter(p => p.stance === team) || [];
    if (teamParticipants.length === 0) return null;
    
    // Use modulo to cycle through participants in each team for each round
    const participantIndex = (round - 1) % teamParticipants.length;
    const selectedParticipant = teamParticipants[participantIndex];
    
    console.log(`[DEBUG] getCurrentRoundParticipant: team=${team}, round=${round}, participants=${teamParticipants.length}, index=${participantIndex}, selected=${selectedParticipant?.displayName}`);
    
    return selectedParticipant;
  };

  // Argument submission
  // 3. When submitting an argument, use the same structure as DebateRoom.tsx
  const handleSubmitArgument = async () => {
    if (!debate || !currentUser || !argument.trim() || !isMyTurn || isSubmitting || debate.status !== 'active' || !hasBothTeams(debate)) return;
    setIsSubmitting(true);
    try {
      // Calculate round based on current round from debate state
      const currentRound = debate.currentRound;
      const newArgument = {
        id: `arg_${Date.now()}`,
        userId: currentUser.uid,
        content: argument.trim(),
        timestamp: Date.now(),
        round: currentRound,
        wordCount: argument.trim().split(' ').length,
      };
      
      // Add argument
      const updatedArguments = [...(debate.arguments || []), newArgument];
      
      // Determine who speaks next based on round-robin system
      const proParticipants = debate.participants.filter(p => p.stance === 'pro');
      const conParticipants = debate.participants.filter(p => p.stance === 'con');
      
      let nextUserId = '';
      let nextTeam: 'pro' | 'con' = 'pro';
      let updatedCurrentRound = currentRound;
      
      // Check if current user is pro or con
      const currentUserStance = debate.participants.find(p => p.userId === currentUser.uid)?.stance;
      
      console.log(`[DEBUG] handleSubmitArgument: currentRound=${currentRound}, currentUserStance=${currentUserStance}, proCount=${proParticipants.length}, conCount=${conParticipants.length}`);
      
      if (currentUserStance === 'pro') {
        // Pro just spoke, now it's con's turn in the same round
        const conSpeaker = getCurrentRoundParticipant('con', currentRound);
        if (conSpeaker) {
          nextUserId = conSpeaker.userId;
          nextTeam = 'con';
          console.log(`[DEBUG] Pro spoke, con's turn: ${conSpeaker.displayName} (${conSpeaker.userId})`);
        }
      } else {
        // Con just spoke, round is complete, move to next round
        updatedCurrentRound = currentRound + 1;
        
        console.log(`[DEBUG] Con spoke, moving to round ${updatedCurrentRound}`);
        
        // Check if debate should end
        if (updatedCurrentRound > maxRounds) {
          console.log(`[DEBUG] Debate should end: round ${updatedCurrentRound} > maxRounds ${maxRounds}`);
          await updateDoc(doc(firestore, 'debates', debate.id), {
            arguments: updatedArguments,
            status: 'completed',
          });
          setArgument('');
          setTimeout(() => handleEndDebate(), 1000);
          return;
        }
        
        // Start next round with pro team
        const proSpeaker = getCurrentRoundParticipant('pro', updatedCurrentRound);
        if (proSpeaker) {
          nextUserId = proSpeaker.userId;
          nextTeam = 'pro';
          console.log(`[DEBUG] Next round ${updatedCurrentRound}, pro's turn: ${proSpeaker.displayName} (${proSpeaker.userId})`);
        }
      }
      
      await updateDoc(doc(firestore, 'debates', debate.id), {
        arguments: updatedArguments,
        currentTurn: nextUserId,
        currentTeam: nextTeam,
        currentRound: updatedCurrentRound,
      });
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
      const currentRound = debate.currentRound;
      const newArgument: DebateArgument = {
        id: `arg_${Date.now()}`,
        userId: currentUser.uid,
        content: '[No argument submitted]',
        timestamp: Date.now(),
        round: currentRound,
        wordCount: 0,
      };
      const updatedArguments = [...(debate.arguments || []), newArgument];
      
      // Determine who speaks next based on round-robin system
      const proParticipants = debate.participants.filter(p => p.stance === 'pro');
      const conParticipants = debate.participants.filter(p => p.stance === 'con');
      
      let nextUserId = '';
      let nextTeam: 'pro' | 'con' = 'pro';
      let updatedCurrentRound = currentRound;
      
      // Check if current user is pro or con
      const currentUserStance = debate.participants.find(p => p.userId === currentUser.uid)?.stance;
      
      if (currentUserStance === 'pro') {
        // Pro just spoke, now it's con's turn in the same round
        const conSpeaker = getCurrentRoundParticipant('con', currentRound);
        if (conSpeaker) {
          nextUserId = conSpeaker.userId;
          nextTeam = 'con';
        }
      } else {
        // Con just spoke, round is complete, move to next round
        updatedCurrentRound = currentRound + 1;
        
        // Check if debate should end
        if (updatedCurrentRound > maxRounds) {
          await updateDoc(doc(firestore, 'debates', debate.id), {
            arguments: updatedArguments,
            status: 'completed',
          });
          setTimeout(() => handleEndDebate(), 2000);
          return;
        }
        
        // Start next round with pro team
        const proSpeaker = getCurrentRoundParticipant('pro', updatedCurrentRound);
        if (proSpeaker) {
          nextUserId = proSpeaker.userId;
          nextTeam = 'pro';
        }
      }
      
      await updateDoc(doc(firestore, 'debates', debate.id), {
        arguments: updatedArguments,
        currentTurn: nextUserId,
        currentTeam: nextTeam,
        currentRound: updatedCurrentRound,
      });
    } catch (e) {
      console.error('Failed to auto submit:', e);
    }
  };

  // End debate and judge
  // 5. When ending the debate, update the full debate object with all metadata, arguments, participants, etc.
  const handleEndDebate = async () => {
    if (!debate || !currentUser) return;
    
    try {
      setIsJudging(true);
      
      // Check if debate has enough arguments for judgment
      if (debate.arguments.length < 2) {
        // End debate without judgment if not enough arguments
        const updatedDebate = {
          ...debate,
          status: 'completed',
          endedAt: Date.now(),
          endReason: 'insufficient_arguments',
        };
        await updateDoc(doc(firestore, 'debates', debate.id), updatedDebate);
        setIsJudging(false);
        return;
      }
      
      // Prepare prompt for judge
      const proParticipants = debate.participants.filter(p => p.stance === 'pro');
      const conParticipants = debate.participants.filter(p => p.stance === 'con');
      
      const argumentsText = debate.arguments.map(arg => {
        const participant = debate.participants.find(p => p.userId === arg.userId);
        return `ROUND ${arg.round} - ${participant?.stance.toUpperCase()} TEAM - ${participant?.displayName}: "${arg.content}"`;
      }).join('\n');
      
      const prompt = `YOU ARE AN EXPERT DEBATE JUDGE. EVALUATE THE FOLLOWING DEBATE AND RETURN ONLY A VALID JSON OBJECT.\n\nSTRICT EVALUATION RULES:\n1. IF NO MEANINGFUL POINTS ARE MADE BY ANYONE: GIVE ZERO TO ALL PARTICIPANTS\n2. IF ANY PARTICIPANT USES ABUSIVE LANGUAGE OR MAKES CONTROVERSIAL STATEMENTS ABOUT RELIGION, COMMUNITY, OR REGION: GIVE ZERO TO THAT PARTICIPANT\n3. ONLY SCORE ARGUMENTS MADE IN ENGLISH, HINDI, OR HINGLISH\n\nOUTPUT FORMAT (JSON ONLY):\n{\n  \"winningTeam\": \"pro\" OR \"con\" OR \"draw\",\n  \"teamScores\": {\n    \"pro\": <0-10, float, 1 decimal>,\n    \"con\": <0-10, float, 1 decimal>\n  },\n  \"individualScores\": {\n    \"<userId1>\": <0-10, float, 1 decimal>,\n    \"<userId2>\": <0-10, float, 1 decimal>\n  },\n  \"individualFeedback\": {\n    \"<userId1>\": [\"<strength1>\", \"<weakness1>\", \"<improvement1>\"],\n    \"<userId2>\": [\"<strength1>\", \"<weakness1>\", \"<improvement1>\"]\n  },\n  \"teamFeedback\": {\n    \"pro\": [\"<strength>\", \"<weakness>\"],\n    \"con\": [\"<strength>\", \"<weakness>\"]\n  },\n  \"reasoning\": \"<detailed explanation of decision>\",\n  \"highlights\": [\"<key moment1>\", \"<key moment2>\"],\n  \"learningPoints\": [\"<learning_point1>\", \"<learning_point2>\"]\n}\n\nDEBATE DATA:\nTOPIC: ${debate.topic}\n\nTEAMS:\nPRO: ${proParticipants.map(p => `${p.displayName} (${p.userId})`).join(', ')}\nCON: ${conParticipants.map(p => `${p.displayName} (${p.userId})`).join(', ')}\n\nARGUMENTS:\n${argumentsText}\n\nEVALUATION CRITERIA (PER PARTICIPANT):\n1. ARGUMENT QUALITY: Clarity, logic, evidence (0-4 pts)\n2. REBUTTAL EFFECTIVENESS: Addressing opponent's points (0-3 pts)\n3. COMMUNICATION: Clarity and persuasiveness (0-2 pts)\n4. DEBATE ETIQUETTE: Respect and rules (0-1 pt)\n\nTEAM SCORES: Average of individual scores per team\n\nIMPORTANT:\n- USE ONLY USERID AS KEYS, NOT DISPLAY NAMES\n- IF NO VALID ARGUMENTS, SCORE 0\n- IF INAPPROPRIATE CONTENT, SCORE 0\n- ONLY SCORE ENGLISH/HINDI/HINGLISH ARGUMENTS`;

        // Map aiModel to judgeWithGroq model string
        const judgeModel = aiModel === 'llama' ? 'llama-3.3-70b-versatile' : aiModel === 'gemma' ? 'gemma2-9b-it' : 'llama-3.3-70b-versatile';
        // Get AI judgment
        const response = await judgeWithGroq(prompt, judgeModel);
        console.log('[DEBUG] AI Judge Raw Response:', response);
        const jsonMatch = response.match(/\{[\s\S]*\}/);
        const judgment = jsonMatch ? JSON.parse(jsonMatch[0]) : null;
        console.log('[DEBUG] AI Judge Parsed Judgment:', judgment);
        
        if (!judgment) {
          console.error('[DEBUG] Failed to parse AI judgment');
          throw new Error('Failed to parse AI judgment');
        }
      // Get AI winner stance from winningTeam (new format)
      let aiWinnerId = judgment?.winner; // Try individual winner first
      
      // If no individual winner, convert winningTeam to individual winner for 1v1 debates
      if (!aiWinnerId && judgment?.winningTeam && debate.participants.length === 2) {
        if (judgment.winningTeam === 'draw') {
          aiWinnerId = null; // Draw
        } else {
          // Find the participant from the winning team
          const winningTeamParticipant = debate.participants.find(p => p.stance === judgment.winningTeam);
          aiWinnerId = winningTeamParticipant?.userId || null;
        }
      }
      
      const aiWinnerParticipant = debate.participants.find(p => p.userId === aiWinnerId);
      const aiWinnerStance = aiWinnerParticipant?.stance;

      // Voting logic is commented out.
      const isDraw = judgment?.winningTeam === 'draw' || aiWinnerId === null;
      const finalWinnerId = aiWinnerId;
      const customJudgment = { ...judgment };
      // Calculate new ratings/points
      let ratings: Record<string, number> | null = null;
      let ratingChanges: Record<string, number> | null = null;
      
      // Only calculate ratings for 1v1 debates (exactly 2 participants)
      if (debate.participants.length === 2) {
        console.log('[DEBUG] EndDebate: Calculating ELO ratings for 1v1 debate');
        try {
          // Fetch current ratings for both participants if not available in debate
          let currentRatings = debate.ratings;
          if (!currentRatings) {
            console.log('[DEBUG] EndDebate: No ratings in debate object, fetching from Firestore');
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
                console.error(`[DEBUG] EndDebate: Failed to fetch rating for ${participant.userId}:`, error);
                currentRatings[participant.userId] = 1200; // Default rating
              }
            }
            console.log('[DEBUG] EndDebate: Fetched current ratings:', currentRatings);
          }
          
          console.log('[DEBUG] EndDebate: isDraw =', isDraw, ', finalWinnerId =', finalWinnerId);
          
          if (isDraw) {
            console.log('[DEBUG] EndDebate: Calculating draw ratings');
            // Award both players equal rating change for a draw
            ratings = calculateDebateRatings(currentRatings, null); // null indicates draw
            ratingChanges = {} as Record<string, number>;
            for (const userId of Object.keys(ratings)) {
              const oldRating = currentRatings[userId];
              const newRating = ratings[userId];
              ratingChanges[userId] = newRating - oldRating;
            }
            console.log('[DEBUG] EndDebate: Draw ratings calculated:', ratings);
            console.log('[DEBUG] EndDebate: Draw rating changes:', ratingChanges);
          } else if (finalWinnerId) {
            console.log('[DEBUG] EndDebate: Calculating winner ratings for:', finalWinnerId);
            // Calculate ratings based on winner
            ratings = calculateDebateRatings(currentRatings, finalWinnerId);
            ratingChanges = {} as Record<string, number>;
            for (const userId of Object.keys(ratings)) {
              const oldRating = currentRatings[userId];
              const newRating = ratings[userId];
              ratingChanges[userId] = newRating - oldRating;
            }
            console.log('[DEBUG] EndDebate: Winner ratings calculated:', ratings);
            console.log('[DEBUG] EndDebate: Winner rating changes:', ratingChanges);
          } else {
            console.log('[DEBUG] EndDebate: No winner determined, skipping ELO calculation');
          }
          
          // Update user ratings in Firestore
          if (ratings) {
            for (const userId of Object.keys(ratings)) {
              try {
                await updateDoc(doc(firestore, 'users', userId), {
                  rating: ratings[userId]
                });
                console.log(`[DEBUG] EndDebate: Updated rating for user ${userId} to ${ratings[userId]}`);
              } catch (err) {
                console.error(`[DEBUG] EndDebate: Failed to update rating for user ${userId}:`, err);
              }
            }
            await refreshUserData();
            
            // Update user stats for all participants (wins, losses, draws, etc.)
            for (const userId of Object.keys(ratings)) {
              try {
                const userRef = doc(firestore, 'users', userId);
                const userSnap = await getDoc(userRef);
                if (!userSnap.exists()) continue;
                
                const userData = userSnap.data();
                let wins = userData.wins || 0;
                let losses = userData.losses || 0;
                let draws = userData.draws || 0;
                let gamesPlayed = userData.gamesPlayed || 0;
                
                // Determine result for this user
                const isDrawResult = isDraw || finalWinnerId === null;
                const isWin = finalWinnerId === userId;
                const isLoss = !isDrawResult && !isWin;
                
                if (isDrawResult) {
                  draws += 1;
                } else if (isWin) {
                  wins += 1;
                } else if (isLoss) {
                  losses += 1;
                }
                gamesPlayed += 1;
                
                const updateObj: any = {
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
                console.log(`[DEBUG] EndDebate: Updated user stats for ${userId}:`, updateObj);
              } catch (error) {
                console.error(`[DEBUG] EndDebate: Failed to update user stats for ${userId}:`, error);
              }
            }
          }
        } catch (error) {
          console.error('[DEBUG] EndDebate: Failed to calculate ratings:', error);
        }
      } else {
        console.log('[DEBUG] EndDebate: Multi-user debate detected, skipping rating calculations. Only showing AI scores.');
      }
      
      // Use debateStore.endDebate to handle all updates (prevents double stats counting)
      await endDebate(debate.id, customJudgment);
      
      // Update debate document with calculated ratings and rating changes if available
      if (ratings && ratingChanges) {
        try {
          await updateDoc(doc(firestore, 'debates', debate.id), {
            ratings: ratings,
            ratingChanges: ratingChanges
          });
          console.log('[DEBUG] EndDebate: Updated debate document with ratings and ratingChanges');
          console.log('[DEBUG] EndDebate: Final ratings:', ratings);
          console.log('[DEBUG] EndDebate: Final ratingChanges:', ratingChanges);
        } catch (error) {
          console.error('[DEBUG] EndDebate: Failed to update debate document with ratings:', error);
        }
      }
      
      setShowJudgment(true);
    } catch (error) {
      console.error('Error ending debate:', error);
      // Still end the debate even if judgment fails
      const updatedDebate = {
        ...debate,
        status: 'completed',
        endedAt: Date.now(),
        endReason: 'error',
      };
      await updateDoc(doc(firestore, 'debates', debate.id), updatedDebate);
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
        winningTeam: opponent.stance, // Winner's team
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
        // Individual scores: winner gets 10, forfeiter gets 0
        individualScores: {
          [opponent.userId]: 10.0,
          [currentUser.uid]: 0.0
        },
        // Team scores: winner's team gets 10, loser's team gets 0
        teamScores: {
          [opponent.stance]: 10.0,
          [debate.participants.find(p => p.userId === currentUser.uid)?.stance || 'pro']: 0.0
        },
        // Individual feedback
        individualFeedback: {
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
        // Team feedback
        teamFeedback: {
          [opponent.stance]: [
            "Team won by opponent forfeit",
            "Victory achieved through opponent withdrawal"
          ],
          [debate.participants.find(p => p.userId === currentUser.uid)?.stance || 'pro']: [
            "Team lost due to forfeit",
            "Consider completing debates for better experience"
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
            console.log('[DEBUG] Forfeit: Fetched current ratings:', currentRatings);
          }
          
          console.log('[DEBUG] Forfeit: Opponent is:', opponent.userId);
          // Calculate ratings using ELO system - opponent wins (gets score 1), current user loses (gets score 0)
          ratings = calculateDebateRatings(currentRatings, opponent.userId);
          ratingChanges = {} as Record<string, number>;
          console.log('[DEBUG] Forfeit: Raw calculated ratings:', ratings);
          
          // Calculate rating changes for both players
          for (const userId of Object.keys(ratings)) {
            const oldRating = currentRatings[userId];
            const newRating = ratings[userId];
            ratingChanges[userId] = newRating - oldRating;
          }
          
          console.log('[DEBUG] Forfeit: Rating changes calculated:', ratingChanges);
          
          // Update user ratings in Firestore
          for (const userId of Object.keys(ratings)) {
            try {
              await updateDoc(doc(firestore, 'users', userId), {
                rating: ratings[userId]
              });
              console.log(`[DEBUG] Forfeit: Updated rating for user ${userId} to ${ratings[userId]}`);
            } catch (err) {
              console.error(`[DEBUG] Forfeit: Failed to update rating for user ${userId}:`, err);
            }
          }
          
          // Update user stats for all participants (wins, losses, draws, etc.)
          for (const userId of Object.keys(ratings)) {
            try {
              const userRef = doc(firestore, 'users', userId);
              const userSnap = await getDoc(userRef);
              if (!userSnap.exists()) continue;
              
              const userData = userSnap.data();
              let wins = userData.wins || 0;
              let losses = userData.losses || 0;
              let draws = userData.draws || 0;
              let gamesPlayed = userData.gamesPlayed || 0;
              
              // For forfeit: opponent wins, current user loses
              const isWin = userId === opponent.userId;
              const isLoss = userId === currentUser.uid;
              
              if (isWin) {
                wins += 1;
              } else if (isLoss) {
                losses += 1;
              }
              gamesPlayed += 1;
              
              const updateObj: any = {
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
              console.log(`[DEBUG] Forfeit: Updated user stats for ${userId}:`, updateObj);
            } catch (error) {
              console.error(`[DEBUG] Forfeit: Failed to update user stats for ${userId}:`, error);
            }
          }
          
          // Refresh current user data
          await refreshUserData();
        } catch (error) {
          console.error('[DEBUG] Forfeit: Failed to calculate ratings:', error);
        }
      } else {
        console.log('[DEBUG] Forfeit: Multi-user debate detected, skipping rating calculations');
      }
      
      // Update debate with forfeit judgment and ratings
      const updateData: any = {
        status: 'completed',
        judgment: forfeitJudgment,
        endedAt: Date.now(),
        endReason: 'forfeit',
        endedBy: currentUser.uid
      };
      
      // Add ratings and rating changes if calculated
      if (ratings) {
        updateData.ratings = ratings;
      }
      if (ratingChanges) {
        updateData.ratingChanges = ratingChanges;
      }
      
      // Use debateStore.endDebate to handle all updates consistently
      await endDebate(debate.id, forfeitJudgment);
      
      // Update debate document with calculated ratings and rating changes if available
      if (ratings && ratingChanges) {
        try {
          await updateDoc(doc(firestore, 'debates', debate.id), {
            ratings: ratings,
            ratingChanges: ratingChanges
          });
          console.log('[DEBUG] Forfeit: Updated debate document with ratings and ratingChanges');
        } catch (error) {
          console.error('[DEBUG] Forfeit: Failed to update debate document with ratings:', error);
        }
      }
      
      // Show judgment modal
      setShowJudgment(true);
      setShowWinner(true);
      
      console.log('[DEBUG] Forfeit: Debate ended successfully with forfeit judgment');
    } catch (error) {
      console.error('[DEBUG] Forfeit: Error ending debate by forfeit:', error);
      // Still try to end the debate even if judgment fails
      const basicUpdate = {
        status: 'completed',
        endedAt: Date.now(),
        endReason: 'forfeit_error',
        endedBy: currentUser.uid
      };
      await updateDoc(doc(firestore, 'debates', debate.id), basicUpdate);
    } finally {
      setIsJudging(false);
    }
  };

  // Auto end debate after maxRounds
  useEffect(() => {
    if (!debate) return;
    if (debate.currentRound > maxRounds && debate.status === 'active') {
      console.log('[DEBUG] UsersDebateRoom: Max rounds exceeded, ending debate');
      handleEndDebate();
    }
  }, [debate, maxRounds]);

  // Determine if current user is a debater
  const isDebater = debate?.participants.some(p => p.userId === currentUser?.uid);

  // Voting handler
  // const handleVote = async (vote: 'pro' | 'con') => {
  //   if (!debate || !currentUser || isDebater || hasVoted) return;
  //   const debateRef = doc(firestore, 'debates', debate.id);
  //   try {
  //     await updateDoc(debateRef, {
  //       [vote === 'pro' ? 'proVotes' : 'conVotes']: (debate[vote === 'pro' ? 'proVotes' : 'conVotes'] || 0) + 1
  //     });
  //     setHasVoted(true);
  //     localStorage.setItem(`debate_voted_${debate.id}_${currentUser.uid}`, '1');
  //   } catch (e) {
  //     console.error('Failed to vote:', e);
  //   }
  // };
  // On mount, check if user has already voted
  // useEffect(() => {
  //   if (debate && currentUser) {
  //     setHasVoted(!!localStorage.getItem(`debate_voted_${debate.id}_${currentUser.uid}`));
  //   }
  // }, [debate, currentUser]);

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
            {id ? `Debate ID: ${id}` : 'No debate ID provided'}
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
  const canSubmit = isMyTurn && !isSubmitting && debate.status === 'active' && debate.currentRound <= maxRounds;
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
    // Try individualScores first (Firebase structure)
    if (judgment.individualScores?.[participant.userId] !== undefined) return judgment.individualScores[participant.userId];
    if (judgment.individualScores?.[participant.displayName] !== undefined) return judgment.individualScores[participant.displayName];
    // Fallback to scores (legacy structure)
    if (judgment.scores?.[participant.userId] !== undefined) return judgment.scores[participant.userId];
    if (judgment.scores?.[participant.displayName] !== undefined) return judgment.scores[participant.displayName];
    return null;
  };
  // Helper to get feedback for a participant
  const getFeedback = (judgment: any, participant: any): string[] => {
    if (!judgment) return [];
    return (
      judgment.individualFeedback?.[participant.userId] ||
      judgment.individualFeedback?.[participant.displayName] ||
      judgment.feedback?.[participant.userId] ||
      judgment.feedback?.[participant.displayName] ||
      []
    );
  };

  // const votingWinnerLabel = (() => {
  //   const proVotes = debate?.proVotes || 0;
  //   const conVotes = debate?.conVotes || 0;
  //   if (proVotes > conVotes) return 'Pro';
  //   if (conVotes > proVotes) return 'Con';
  //   return 'Draw';
  // })();

  return (
    <div className="relative min-h-screen w-full flex flex-col bg-black text-white select-none" style={{background: '#000'}}>
      {/* Always show header at the top */}
      <div className="w-full flex items-center justify-between px-6 py-4 bg-black/80 border-b border-gray-800" style={{position: 'sticky', top: 0, left: 0, zIndex: 50}}>
        <div className="flex items-center gap-4">
          <div className="text-lg font-bold max-w-[70vw] leading-tight break-words" title={debate?.topic || 'Loading...'}>{debate?.topic || 'Loading...'}</div>
          {/* Round Counter */}
          {debate && (
            <div className="flex items-center gap-2 text-sm text-gray-400">
              <RotateCcw className="w-4 h-4" />
              <span>Round {debate.currentRound}/{maxRounds}</span>
            </div>
          )}
          {/* Timer */}
          {!isDebateCompleted && debate?.status === 'active' && (
            <div className="flex items-center gap-2">
              <Clock className={`w-4 h-4 ${hasBothTeams(debate) ? (isMyTurn ? 'text-orange-400' : 'text-blue-400') : 'text-gray-400'}`} />
              <span className={`text-sm font-medium ${hasBothTeams(debate) ? (isMyTurn ? 'text-orange-400' : 'text-blue-400') : 'text-gray-400'}`}>
                {hasBothTeams(debate) ? (
                  isMyTurn ? `Your turn: ${timeLeft}s` : (
                    getCurrentSpeaker() ? `${getCurrentSpeaker()?.displayName} speaking: ${timeLeft}s` : 'Waiting...'
                  )
                ) : 'Waiting for both teams...'}
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
      
      {/* Teams Info Bar */}
      {debate && (
        <div className="w-full bg-[#0a0a0a] border-b border-gray-800 px-6 py-3">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-6">
              {/* Left Team */}
              <div className="flex items-center gap-3">
                <img
                  src={myParticipant?.stance === 'pro' ? '/con-left.png' : '/pro-left.png'}
                  alt="Opposition Team"
                  className="w-8 h-8 object-contain rounded-full border border-gray-600"
                />
                <div className="text-sm">
                  <div className="font-semibold text-white">
                    {myParticipant?.stance === 'pro' ? 'CON TEAM' : 'PRO TEAM'}
                  </div>
                  <div className="text-gray-400 text-xs">
                    {debate.participants.filter(p => p.stance === (myParticipant?.stance === 'pro' ? 'con' : 'pro')).length} members
                    {debate.status === 'active' && (() => {
                      const opponentTeam = myParticipant?.stance === 'pro' ? 'con' : 'pro';
                      const currentRoundSpeaker = getCurrentRoundParticipant(opponentTeam, debate.currentRound);
                      return currentRoundSpeaker ? (
                        <span className="block text-blue-300 font-medium">
                          {participantDetails[currentRoundSpeaker.userId]?.displayName || currentRoundSpeaker.displayName}
                        </span>
                      ) : null;
                    })()}
                  </div>
                </div>
              </div>
              {/* VS Separator */}
              <div className="text-gray-500 text-sm font-medium">VS</div>
              {/* Right Team (Current User's Team) */}
              <div className="flex items-center gap-3">
                <div className="text-sm text-right">
                  <div className="font-semibold text-white">
                    <span className="font-bold text-green-400">{myParticipant?.stance === 'pro' ? 'PRO TEAM' : 'CON TEAM'}</span>
                  </div>
                  <div className="text-gray-400 text-xs">
                    {debate.participants.filter(p => p.stance === myParticipant?.stance).length} members
                    {debate.status === 'active' && myParticipant && (() => {
                      const currentRoundSpeaker = getCurrentRoundParticipant(myParticipant.stance, debate.currentRound);
                      return currentRoundSpeaker ? (
                        <span className="block text-green-300 font-medium">
                          {participantDetails[currentRoundSpeaker.userId]?.displayName || currentRoundSpeaker.displayName}
                        </span>
                      ) : null;
                    })()}
                  </div>
                </div>
                <img
                  src={myParticipant?.stance === 'pro' ? '/pro-right.png' : '/con-right.png'}
                  alt="Your Team"
                  className="w-8 h-8 object-contain rounded-full border border-gray-600"
                />
              </div>
            </div>
            {/* Current Turn Indicator */}
            {!isDebateCompleted && debate?.status === 'active' && (
              <div className="flex items-center gap-2 text-sm">
                {hasBothTeams(debate) ? (
                  <>
                    <div className={`w-2 h-2 rounded-full ${isMyTurn ? 'bg-green-400 animate-pulse' : 'bg-blue-400 animate-pulse'}`}></div>
                    <span className={isMyTurn ? 'text-green-400' : 'text-blue-400'}>
                      {isMyTurn ? 'Your turn' : (
                        getCurrentSpeaker() ? `${getCurrentSpeaker()?.displayName} is speaking` : `${debate.currentTeam?.toUpperCase()} team's turn`
                      )}
                    </span>
                  </>
                ) : (
                  <>
                    <div className="w-2 h-2 rounded-full bg-gray-400"></div>
                    <span className="text-gray-400">
                      Waiting for both teams to join...
                    </span>
                  </>
                )}
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
              
              // Determine alignment based on user's stance and message stance
              // If user is PRO: show PRO messages on right, CON on left
              // If user is CON: show CON messages on right, PRO on left
              const userIsPro = myParticipant?.stance === 'pro';
              const showOnRight = userIsPro ? isPro : isCon;
              
              const avatarSrc = showOnRight ? 
                (isPro ? '/pro-right.png' : '/con-right.png') : 
                (isPro ? '/pro-left.png' : '/con-left.png');
              
              const alignment = showOnRight ? 'justify-end' : 'justify-start';
              const bubbleAlign = showOnRight ? 'flex-row-reverse' : 'flex-row';
              
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
                        ${showOnRight ? (isPro ? 'bg-[#1a1a1a] text-green-200 border-r-4 border-green-500' : 'bg-[#181a22] text-red-200 border-r-4 border-red-500') : (isPro ? 'bg-[#1a1a1a] text-green-200 border-l-4 border-green-500' : 'bg-[#181a22] text-red-200 border-l-4 border-red-500')}
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
      {debate?.status === 'active' && (
        <div className="w-full bg-[#101010] border-t border-gray-800 px-2 md:px-8 py-4 flex flex-col gap-0 sticky bottom-0 z-20" style={{boxShadow: '0 -2px 16px 0 #0008'}}>
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
        {/* Argument input */}
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
            disabled={!debate || isSubmitting || isDebateCompleted || (debate && debate.currentRound <= maxRounds)}
            className={`px-6 py-2 rounded-xl font-semibold transition-all duration-300 flex items-center gap-2 bg-gradient-to-r from-orange-500 to-red-500 text-white hover:from-orange-600 hover:to-red-600 shadow-lg hover:shadow-xl mr-2 ${isDebateCompleted || (debate && debate.currentRound <= maxRounds) ? 'opacity-60 cursor-not-allowed' : ''}`}
            title={debate && debate.currentRound <= maxRounds ? 'The debate can only be ended after completion of all rounds' : 'End Debate'}
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
            placeholder={
              isDebateCompleted
                ? 'Debate has ended.'
                : !hasBothTeams(debate)
                ? 'Waiting for opponent to join...'
                : isMyTurn
                ? 'Type your argument...'
                : 'Waiting for your turn...'
            }
            disabled={!isMyTurn || !hasBothTeams(debate) || isSubmitting || isDebateCompleted || isTranscribing}
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
            disabled={!isMyTurn || !hasBothTeams(debate) || !argument.trim() || isSubmitting || isDebateCompleted || isTranscribing}
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
        </div>
      )}
      
      {/* After the chat area, but before the modals, add a new section for winner and scores if debate is completed and judgment is present */}
      {isDebateCompleted && debate.judgment && (() => {
        const judgment = debate.judgment;
        // Handle Firebase judgment structure
        let winnerId = judgment.winner;
        let winnerName = "No winner";
        
        // If we have winningTeam instead of individual winner
        if (judgment.winningTeam && !winnerId) {
          winnerName = judgment.winningTeam === 'pro' ? 'PRO Team' : 'CON Team';
        } else if (winnerId) {
          let winnerParticipant = debate.participants.find(
            p => p.userId === winnerId || p.displayName === winnerId
          );
          winnerName = winnerParticipant?.displayName || winnerId || "No winner";
        }
        
        // Scores: robust mapping for Firebase structure
        const getScore = (uid: string) => {
          // Try individualScores first (Firebase structure)
          if (judgment.individualScores?.[uid] !== undefined) return judgment.individualScores[uid];
          // Try to find by displayName if not found by userId
          const participant = debate.participants.find(p => p.displayName === uid);
          if (participant && judgment.individualScores?.[participant.userId] !== undefined) {
            return judgment.individualScores[participant.userId];
          }
          // Fallback to legacy scores structure
          if (judgment.scores?.[uid] !== undefined) return judgment.scores[uid];
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
                      {(isCurrentUser || debate.participants.length === 2) && (
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
            {/* <div className="flex gap-6">
              <span className="text-green-400 font-bold">Pro votes: {debate?.proVotes || 0}</span>
              <span className="text-red-400 font-bold">Con votes: {debate?.conVotes || 0}</span>
            </div> */}
            {/* <div className="text-sm text-gray-300 mt-1">
              Voting winner: {votingWinnerLabel}
            </div> */}
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
            // Handle Firebase judgment structure
            let winnerId = judgment.winner;
            let winnerName = "No winner";
            
            // If we have winningTeam instead of individual winner
            if (judgment.winningTeam && !winnerId) {
              winnerName = judgment.winningTeam === 'pro' ? 'PRO Team' : 'CON Team';
            } else if (winnerId) {
              let winnerParticipant = debate.participants.find(
                p => p.userId === winnerId || p.displayName === winnerId
              );
              winnerName = winnerParticipant?.displayName || winnerId || "No winner";
            }
            
            // Scores: robust mapping for Firebase structure
            const getScore = (uid: string) => {
              // Try individualScores first (Firebase structure)
              if (judgment.individualScores?.[uid] !== undefined) return judgment.individualScores[uid];
              // Try to find by displayName if not found by userId
              const participant = debate.participants.find(p => p.displayName === uid);
              if (participant && judgment.individualScores?.[participant.userId] !== undefined) {
                return judgment.individualScores[participant.userId];
              }
              // Fallback to legacy scores structure
              if (judgment.scores?.[uid] !== undefined) return judgment.scores[uid];
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
                          {(isCurrentUser || debate.participants.length === 2) && (
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

      {/* Stance Selection Modal */}
      {showStanceModal && (
        <Modal
          open={showStanceModal}
          onClose={() => {}}
        >
          <div className="space-y-6 overflow-y-auto overflow-x-hidden p-1">
            <div className="text-center">
              <h2 className="text-2xl font-bold mb-2">Choose Your Side</h2>
              <h3 className="text-xl font-bold mb-2">Join the Tournament</h3>
              <p className="text-gray-400">Choose which side you want to argue for in this debate:</p>
              <p className="text-base font-semibold mt-2 text-blue-400 leading-tight break-words">{debate?.topic}</p>
            </div>

            <div className="grid grid-cols-2 gap-4">
              <button
                onClick={() => setSelectedStance('pro')}
                className={`p-6 rounded-xl border-2 transition-all ${
                  selectedStance === 'pro'
                    ? 'border-green-500 bg-green-500/20'
                    : 'border-gray-600 bg-gray-800/50 hover:border-green-400'
                }`}
              >
                <div className="flex flex-col items-center gap-3">
                  <img
                    src="/pro-right.png"
                    alt="Pro"
                    className="w-16 h-16 object-contain"
                  />
                  <div>
                    <div className="text-lg font-bold text-green-400">PRO</div>
                    <div className="text-sm text-gray-400">Argue in favor</div>
                    <div className="text-xs text-gray-500 mt-1">
                      {debate?.participants.filter(p => p.stance === 'pro').length} members
                    </div>
                  </div>
                </div>
              </button>

              <button
                onClick={() => setSelectedStance('con')}
                className={`p-6 rounded-xl border-2 transition-all ${
                  selectedStance === 'con'
                    ? 'border-red-500 bg-red-500/20'
                    : 'border-gray-600 bg-gray-800/50 hover:border-red-400'
                }`}
              >
                <div className="flex flex-col items-center gap-3">
                  <img
                    src="/con-right.png"
                    alt="Con"
                    className="w-16 h-16 object-contain"
                  />
                  <div>
                    <div className="text-lg font-bold text-red-400">CON</div>
                    <div className="text-sm text-gray-400">Argue against</div>
                    <div className="text-xs text-gray-500 mt-1">
                      {debate?.participants.filter(p => p.stance === 'con').length} members
                    </div>
                  </div>
                </div>
              </button>
            </div>

            <Button
              onClick={() => handleJoinWithStance(selectedStance)}
              className="w-full"
              disabled={!selectedStance}
            >
              Join as {selectedStance?.toUpperCase()} Team
            </Button>
          </div>
        </Modal>
      )}
    </div>
  );
};

export default UsersDebateRoom;
