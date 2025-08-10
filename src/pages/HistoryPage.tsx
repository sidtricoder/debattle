import React, { useState } from 'react';
import { motion } from 'framer-motion';
import { Link } from 'react-router-dom';
import { Calendar, Clock, Trophy, TrendingUp, TrendingDown, Minus, Search, Filter, ArrowDownAZ, ArrowDownZA, ArrowDownWideNarrow } from 'lucide-react';
import { ChatLoadingAnimation } from '../components/animations/ChatLoadingAnimation';
import { useAuth } from '../components/auth/AuthProvider';
import { useDebateStore } from '../stores/debateStore';
import { useEffect } from 'react';

interface DebateHistory {
  id: string;
  topic: string;
  opponent: {
    name: string;
    rating: number;
    photoURL: string;
  };
  result: 'win' | 'loss' | 'draw';
  date: Date;
  duration: number; // in minutes
  ratingChange: number;
  score: {
    user: number;
    opponent: number;
  };
  category: string;
}

const HistoryPage: React.FC = () => {
  const { user } = useAuth();
  const [searchTerm, setSearchTerm] = useState('');
  const [selectedResult, setSelectedResult] = useState<'all' | 'win' | 'loss' | 'draw'>('all');
  const [selectedCategory, setSelectedCategory] = useState('all');
  const [selectedType, setSelectedType] = useState<'all' | 'practice' | 'user'>('all');
  const [sortBy, setSortBy] = useState<'date' | 'rating' | 'duration'>('date');
  const [selectedTopic, setSelectedTopic] = useState('all');
  const [sortModalOpen, setSortModalOpen] = useState(false);

  const { debatesHistory, loadDebateHistory, isLoading } = useDebateStore();

  useEffect(() => {
    if (user?.uid) {
      loadDebateHistory(user.uid);
    }
  }, [user, loadDebateHistory]);

  // Helper function to migrate debate timestamps if needed
  const migrateDebateTimestamps = async (debate: any) => {
    // This function can be used to fix existing debates with inconsistent timestamps
    // For now, we'll just log any issues we find
    if (debate.createdAt && typeof debate.createdAt === 'object' && debate.createdAt.toDate) {
      console.warn('[DEBUG] Found Firestore timestamp in createdAt for debate:', debate.id);
    }
    if (debate.endedAt && typeof debate.endedAt === 'object' && debate.endedAt.toDate) {
      console.warn('[DEBUG] Found Firestore timestamp in endedAt for debate:', debate.id);
    }
  };

  // Convert Firestore debates to the expected format for filtering/sorting
  const debates = debatesHistory.map(d => {
    let duration = 0;
    let rawDiff = 0;
    
    // Helper function to safely convert timestamp to number
    const safeTimestamp = (timestamp: any, isCreatedAt?: boolean): number => {
      if (!timestamp) return 0;
      // If createdAt is a string or Firestore Timestamp, parse as date
      if (isCreatedAt) {
        if (typeof timestamp === 'string') {
          const parsed = Date.parse(timestamp);
          return isNaN(parsed) ? 0 : parsed;
        }
        if (timestamp instanceof Date) {
          return timestamp.getTime();
        }
        if (timestamp && typeof timestamp === 'object' && timestamp.toDate) {
          return timestamp.toDate().getTime();
        }
      }
      // If number, use as-is
      if (typeof timestamp === 'number') {
        return timestamp;
      }
      // Fallbacks
      if (timestamp instanceof Date) {
        return timestamp.getTime();
      }
      if (typeof timestamp === 'string') {
        const parsed = Date.parse(timestamp);
        return isNaN(parsed) ? 0 : parsed;
      }
      if (timestamp && typeof timestamp === 'object' && timestamp.toDate) {
        return timestamp.toDate().getTime();
      }
      const num = Number(timestamp);
      return isNaN(num) ? 0 : num;
    };
    // Helper function to calculate duration in minutes
    const calculateDuration = (endTime: number, startTime: number): number => {
      if (endTime <= 0 || startTime <= 0) return 0;
      const diffMs = endTime - startTime;
      if (diffMs < 0) return 0;
      if (diffMs > 24 * 60 * 60 * 1000) return 0;
      return Math.round(diffMs / 60000);
    };
    // Try different duration calculation methods
    if (d.metadata?.debateDuration && !isNaN(Number(d.metadata.debateDuration))) {
      const debateDuration = Number(d.metadata.debateDuration);
      duration = Math.round(debateDuration / 60000);
    } else if (d.endedAt && d.startedAt) {
      // Dynamically check type of startedAt
      const endTime = safeTimestamp(d.endedAt, false);
      const startTimeStarted = safeTimestamp(
        d.startedAt,
        typeof d.startedAt === 'string' ||
          (typeof d.startedAt === 'object' && d.startedAt !== null && 'toDate' in d.startedAt)
      );
      duration = calculateDuration(endTime, startTimeStarted);
    } else if (d.endedAt && d.createdAt) {
      // Dynamically check type of createdAt
      const endTime = safeTimestamp(d.endedAt, false);
      const startTimeCreated = safeTimestamp(
        d.createdAt,
        typeof d.createdAt === 'string' ||
          (typeof d.createdAt === 'object' && d.createdAt !== null && 'toDate' in d.createdAt)
      );
      duration = calculateDuration(endTime, startTimeCreated);
    }
    
    // Debug logging for duration calculation
    if (duration > 1000) { // If duration is suspiciously large
      console.warn('[DEBUG] Large duration detected:', {
        debateId: d.id,
        duration,
        endedAt: d.endedAt,
        startedAt: d.startedAt,
        createdAt: d.createdAt,
        metadata: d.metadata
      });
    }
    
    // Check for timestamp format issues
    migrateDebateTimestamps(d);
    
    // Get opponent details with fallback for display names
    const opponent = d.participants.find(p => p.userId !== user?.uid);
    let opponentName = opponent?.displayName || 'AI Opponent';
    
    // If opponent name looks like a fallback or is missing, try to get a better name
    if (opponent && opponent.userId !== 'ai_opponent' && 
        (!opponentName || opponentName === 'You' || opponentName === 'Opponent' || opponentName.startsWith('User '))) {
      // For now, use a fallback name - in a real app, you'd fetch from Firestore
      opponentName = `User ${opponent.userId.slice(-4)}`;
    }
    
    // Calculate rating change if not present
    let ratingChange = d.ratingChanges?.[user?.uid || ''] || 0;
    if (ratingChange === 0 && d.ratings && d.judgment?.winner) {
      // Try to calculate rating change from stored ratings
      const oldRating = d.ratings[user?.uid || ''];
      const newRating = d.ratings[user?.uid || ''];
      if (oldRating && newRating) {
        ratingChange = newRating - oldRating;
      }
    }
    
    let safeCreatedAt = safeTimestamp(d.createdAt, typeof d.createdAt === 'string' || (typeof d.createdAt === 'object' && d.createdAt !== null && 'toDate' in d.createdAt));
    let safeEndedAt = safeTimestamp(d.endedAt, false);
    if (safeCreatedAt && safeEndedAt) {
      rawDiff = safeEndedAt - safeCreatedAt;
    }
    
    // Determine result based on debate type
    let result: 'win' | 'loss' | 'draw' = 'draw';
    
    // Check if this is a custom debate (has winningTeam field in judgment)
    const winningTeam = (d.judgment as any)?.winningTeam;
    if (winningTeam !== undefined) {
      // Custom debate - check winningTeam
      if (winningTeam === "" || winningTeam === "No Winner" || winningTeam === "draw") {
        result = 'draw';
      } else {
        // Find user's stance in the debate
        const userParticipant = d.participants.find((p: any) => p.userId === user?.uid);
        const userStance = userParticipant?.stance; // should be 'pro' or 'con'
        
        if (userStance && winningTeam === userStance) {
          result = 'win';
        } else if (userStance && winningTeam !== userStance) {
          result = 'loss';
        } else {
          result = 'draw'; // fallback if user stance is not found
        }
      }
    } else {
      // Regular debate - use existing logic
      result = d.judgment?.winner === user?.uid ? 'win' : (d.judgment?.winner ? 'loss' : 'draw');
    }

    return {
      ...d,
      date: new Date(safeEndedAt || safeCreatedAt || Date.now()),
      result: result,
      opponent: {
        name: opponentName,
        rating: opponent?.rating || 1200,
        photoURL: ''
      },
      duration,
      rawDiff, // add rawDiff to the returned object
      ratingChange,
      score: {
        user: (d.judgment as any)?.individualScores?.[user?.uid || ''] || 
              (d.judgment as any)?.individualScores?.[user?.displayName || ''] ||
              d.judgment?.scores?.[user?.uid || ''] || 0,
        opponent: (d.judgment as any)?.individualScores?.[opponent?.userId || ''] || 
                  (d.judgment as any)?.individualScores?.[opponent?.displayName || ''] ||
                  d.judgment?.scores?.[opponent?.userId || ''] || 0
      },
      category: d.category
    };
  });

  const filteredHistory = debates.filter(debate => {
    const matchesSearch = debate.topic.toLowerCase().includes(searchTerm.toLowerCase()) ||
                         debate.opponent.name.toLowerCase().includes(searchTerm.toLowerCase());
    const matchesResult = selectedResult === 'all' || debate.result === selectedResult;
    const matchesTopic = selectedTopic === 'all' || debate.topic === selectedTopic;
    // Debate type filter
    let matchesType = true;
    if (selectedType === 'practice') {
      matchesType = Array.isArray(debate.participants) && debate.participants.some((p: any) => p.userId === 'ai_opponent');
    } else if (selectedType === 'user') {
      matchesType = Array.isArray(debate.participants) && !debate.participants.some((p: any) => p.userId === 'ai_opponent');
    }
    return matchesSearch && matchesResult && matchesTopic && matchesType;
  });

  const sortedHistory = [...filteredHistory].sort((a, b) => {
    switch (sortBy) {
      case 'date':
        return b.date.getTime() - a.date.getTime();
      case 'rating':
        return Math.abs(b.ratingChange) - Math.abs(a.ratingChange);
      case 'duration':
        return b.duration - a.duration;
      default:
        return 0;
    }
  });

  // Compute available topics from debates matching all filters except topic
  const debatesForTopicFilter = debates.filter(debate => {
    const matchesSearch = debate.topic.toLowerCase().includes(searchTerm.toLowerCase()) ||
                         debate.opponent.name.toLowerCase().includes(searchTerm.toLowerCase());
    const matchesResult = selectedResult === 'all' || debate.result === selectedResult;
    let matchesType = true;
    if (selectedType === 'practice') {
      matchesType = Array.isArray(debate.participants) && debate.participants.some((p: any) => p.userId === 'ai_opponent');
    } else if (selectedType === 'user') {
      matchesType = Array.isArray(debate.participants) && !debate.participants.some((p: any) => p.userId === 'ai_opponent');
    }
    return matchesSearch && matchesResult && matchesType;
  });
  const availableTopics = ['all', ...Array.from(new Set(debatesForTopicFilter.map(d => d.topic).filter(Boolean)))];

  const stats = {
    total: debates.length,
    wins: debates.filter(d => d.result === 'win').length,
    losses: debates.filter(d => d.result === 'loss').length,
    draws: debates.filter(d => d.result === 'draw').length,
    winRate: debates.length ? Math.round((debates.filter(d => d.result === 'win').length / debates.length) * 100) : 0,
    totalRatingChange: debates.reduce((sum, d) => sum + d.ratingChange, 0),
    avgDurationMs: debates.length ? Math.round(debates.reduce((sum, d) => sum + (d.rawDiff || 0), 0) / debates.length) : 0
  };

  const formatDate = (date: Date) => {
    try {
      if (!(date instanceof Date) || isNaN(date.getTime())) return 'N/A';
      return new Intl.DateTimeFormat('en-US', {
        month: 'short',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit'
      }).format(date);
    } catch {
      return 'N/A';
    }
  };

  const formatDuration = (minutes: number) => {
    if (minutes <= 0) return '0m';
    if (minutes < 60) return `${minutes}m`;
    const hours = Math.floor(minutes / 60);
    const remainingMinutes = minutes % 60;
    return remainingMinutes > 0 ? `${hours}h ${remainingMinutes}m` : `${hours}h`;
  };

  const getResultIcon = (result: string) => {
    switch (result) {
      case 'win':
        return <TrendingUp className="w-4 h-4 text-green-500" />;
      case 'loss':
        return <TrendingDown className="w-4 h-4 text-red-500" />;
      case 'draw':
        return <Minus className="w-4 h-4 text-yellow-500" />;
      default:
        return null;
    }
  };

  const getResultColor = (result: string) => {
    switch (result) {
      case 'win':
        return 'text-green-600 dark:text-green-400';
      case 'loss':
        return 'text-red-600 dark:text-red-400';
      case 'draw':
        return 'text-yellow-600 dark:text-yellow-400';
      default:
        return 'text-gray-600 dark:text-gray-400';
    }
  };

  // Helper to format ms to minutes and seconds
  function formatMsToMinSec(ms: number) {
    if (!ms || ms < 0) return '0m';
    const totalSeconds = Math.floor(ms / 1000);
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    if (minutes > 0) {
      return `${minutes}m${seconds > 0 ? ' ' + seconds + 's' : ''}`;
    }
    return `${seconds}s`;
  }

  // Replace all mockHistory references with debates
  // Show loading state
  if (isLoading) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-blue-50 to-indigo-100 dark:from-gray-900 dark:to-gray-900 flex items-center justify-center p-4">
        <ChatLoadingAnimation 
          message="Loading your debate history..." 
          className="py-20"
        />
      </div>
    );
  }

  // Show empty state
  if (!debates.length) {
    return <div className="p-8 text-center">No debates found. Try participating in a debate!</div>;
  }

  return (
    <div className="min-h-screen bg-gradient-to-br from-gray-50 to-blue-50 dark:from-gray-900 dark:to-gray-800">
      <style>{`@import url('https://fonts.googleapis.com/css2?family=Great+Vibes&display=swap');`}</style>
      <div className="container mx-auto px-6 py-8">
        {/* Header */}
        <motion.div
          initial={{ opacity: 0, y: -20 }}
          animate={{ opacity: 1, y: 0 }}
          className="text-center mb-8"
        >
          <h1
            className="mb-4"
            style={{
              fontFamily: "'Great Vibes', cursive",
              fontWeight: 700,
              fontSize: '3.5rem',
              color: '#4f46e5',
              letterSpacing: '1px',
              textShadow: '0 2px 12px rgba(79,70,229,0.08)'
            }}
          >
            Debate History
          </h1>
          <p className="text-lg text-gray-600 dark:text-gray-300">
            Track your performance and analyze your debating journey
          </p>
        </motion.div>

        {/* Stats Overview */}
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.1 }}
          className="grid md:grid-cols-4 gap-0 mb-8 divide-x divide-gray-200 dark:divide-gray-700 bg-transparent"
        >
          <div className="p-6 text-center bg-transparent">
            <div className="text-3xl font-bold text-blue-600 dark:text-blue-400 mb-2">
              {stats.total}
            </div>
            <div className="text-gray-600 dark:text-gray-300">Total Debates</div>
          </div>
          
          <div className="p-6 text-center bg-transparent">
            <div className="text-3xl font-bold text-green-600 dark:text-green-400 mb-2">
              {stats.winRate}%
            </div>
            <div className="text-gray-600 dark:text-gray-300">Win Rate</div>
          </div>
          
          <div className="p-6 text-center bg-transparent">
            <div className="text-3xl font-bold text-purple-600 dark:text-purple-400 mb-2">
              {stats.totalRatingChange > 0 ? '+' : ''}{stats.totalRatingChange}
            </div>
            <div className="text-gray-600 dark:text-gray-300">Rating Change</div>
          </div>
          
          <div className="p-6 text-center bg-transparent">
            <div className="text-3xl font-bold text-orange-600 dark:text-orange-400 mb-2">
              {formatMsToMinSec(stats.avgDurationMs)}
            </div>
            <div className="text-gray-600 dark:text-gray-300">Avg Duration</div>
          </div>
        </motion.div>

        {/* Filters */}
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.2 }}
          className="bg-transparent p-6 mb-8 border-b border-gray-200 dark:border-gray-700"
        >
          <div className="flex flex-col md:flex-row gap-4 items-center flex-wrap">
            {/* Result Filter - Segmented Buttons (left of search) */}
            <div className="inline-flex rounded-full shadow-sm overflow-hidden border border-yellow-500 bg-white dark:bg-gray-700 my-2 order-1 md:order-1">
              {['all', 'win', 'loss', 'draw'].map((result, idx, arr) => {
                let bg = '';
                let text = '';
                if (result === 'all') { bg = selectedResult === 'all' ? 'bg-yellow-400 text-white' : 'text-yellow-700 dark:text-yellow-300'; text = 'All'; }
                if (result === 'win') { bg = selectedResult === 'win' ? 'bg-green-600 text-white' : 'text-green-700 dark:text-green-300'; text = 'Win'; }
                if (result === 'loss') { bg = selectedResult === 'loss' ? 'bg-red-600 text-white' : 'text-red-700 dark:text-red-300'; text = 'Loss'; }
                if (result === 'draw') { bg = selectedResult === 'draw' ? 'bg-blue-600 text-white' : 'text-blue-700 dark:text-blue-300'; text = 'Draw'; }
                return (
                  <button
                    key={result}
                    onClick={() => setSelectedResult(result as any)}
                    className={`px-5 py-2 font-medium transition-all duration-200 focus:outline-none border-0 ${bg} ${idx === 0 ? 'rounded-l-full' : ''} ${idx === arr.length - 1 ? 'rounded-r-full' : ''}`}
                  >
                    {text}
                  </button>
                );
              })}
            </div>
            {/* Search */}
            <div className="flex-1 relative order-2 md:order-2">
              <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 text-gray-400 w-5 h-5" />
              <input
                type="text"
                placeholder="Search topics or opponents..."
                value={searchTerm}
                onChange={(e) => setSearchTerm(e.target.value)}
                className="w-full pl-10 pr-4 py-3 border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-700 text-gray-900 dark:text-white focus:ring-2 focus:ring-blue-500 focus:border-transparent"
              />
            </div>
            {/* Type Filter - Segmented Buttons (right of search) */}
            <div className="inline-flex rounded-full shadow-sm overflow-hidden border border-blue-600 bg-white dark:bg-gray-700 my-2 order-3 md:order-3 ml-auto">
              {['all', 'practice', 'user'].map((type, idx, arr) => (
                <button
                  key={type}
                  onClick={() => setSelectedType(type as any)}
                  className={`px-5 py-2 font-medium transition-all duration-200 focus:outline-none
                    ${selectedType === type
                      ? 'bg-blue-600 text-white'
                      : 'text-blue-600 dark:text-blue-300 bg-transparent hover:bg-blue-50 dark:hover:bg-blue-800'}
                    ${idx === 0 ? 'rounded-l-full' : ''}
                    ${idx === arr.length - 1 ? 'rounded-r-full' : ''}
                    border-0
                  `}
                >
                  {type === 'all' ? 'All' : type.charAt(0).toUpperCase() + type.slice(1)}
                </button>
              ))}
            </div>
            {/* Line separator */}
            <div className="w-full h-1 my-4 bg-gradient-to-r from-blue-400 via-purple-400 to-pink-400 rounded-full order-4" />
            {/* Topic Filter - Dropdown */}
            <select
              value={selectedTopic}
              onChange={(e) => setSelectedTopic(e.target.value)}
              className="px-4 py-3 border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-700 text-gray-900 dark:text-white focus:ring-2 focus:ring-blue-500 focus:border-transparent ml-auto order-5 md:order-5"
            >
              {availableTopics.map(topic => (
                <option key={topic} value={topic}>
                  {topic === 'all' ? 'All Topics' : topic}
                </option>
              ))}
            </select>
            {/* Sort By - Icon Button and Modal */}
            <div className="relative">
              <button
                onClick={() => setSortModalOpen(true)}
                className="flex items-center gap-2 px-4 py-2 rounded-full font-medium transition-all duration-200 border bg-white dark:bg-gray-700 text-gray-900 dark:text-white border-gray-300 dark:border-gray-600 hover:bg-gray-100 dark:hover:bg-gray-800"
                title="Sort"
              >
                <ArrowDownWideNarrow className="w-5 h-5" />
                Sort
              </button>
              {/* Sort Modal as Popover Dropdown */}
              {sortModalOpen && (
                <div className="absolute right-0 mt-2 z-50 bg-white dark:bg-gray-900 rounded-2xl shadow-2xl p-6 w-56 flex flex-col gap-4 border border-gray-200 dark:border-gray-700">
                  {/* Close button */}
                  <button
                    onClick={() => setSortModalOpen(false)}
                    className="absolute top-3 right-3 p-2 rounded-full hover:bg-gray-200 dark:hover:bg-gray-800 text-gray-500 dark:text-gray-300"
                    aria-label="Close"
                  >
                    <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor" className="w-5 h-5">
                      <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                    </svg>
                  </button>
                  <h3 className="text-lg font-semibold mb-2 text-gray-900 dark:text-white text-center">Sort By</h3>
                  <button
                    onClick={() => { setSortBy('date'); setSortModalOpen(false); }}
                    className={`w-full px-4 py-3 rounded-lg text-left font-medium transition-colors ${sortBy === 'date' ? 'bg-blue-600 text-white' : 'bg-gray-100 dark:bg-gray-800 text-gray-900 dark:text-white hover:bg-blue-100 dark:hover:bg-blue-800'}`}
                  >
                    Date
                  </button>
                  <button
                    onClick={() => { setSortBy('rating'); setSortModalOpen(false); }}
                    className={`w-full px-4 py-3 rounded-lg text-left font-medium transition-colors ${sortBy === 'rating' ? 'bg-blue-600 text-white' : 'bg-gray-100 dark:bg-gray-800 text-gray-900 dark:text-white hover:bg-blue-100 dark:hover:bg-blue-800'}`}
                  >
                    Rating Change
                  </button>
                  <button
                    onClick={() => { setSortBy('duration'); setSortModalOpen(false); }}
                    className={`w-full px-4 py-3 rounded-lg text-left font-medium transition-colors ${sortBy === 'duration' ? 'bg-blue-600 text-white' : 'bg-gray-100 dark:bg-gray-800 text-gray-900 dark:text-white hover:bg-blue-100 dark:hover:bg-blue-800'}`}
                  >
                    Duration
                  </button>
                </div>
              )}
            </div>
          </div>
        </motion.div>

        {/* Debate History List */}
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.3 }}
          className="divide-y-4 divide-gray-400 dark:divide-gray-700"
        >
          {sortedHistory.map((debate, index) => (
            <motion.div
              key={debate.id || index}
              initial={{ opacity: 0, x: -20 }}
              animate={{ opacity: 1, x: 0 }}
              transition={{ delay: 0.1 * index }}
              className="bg-transparent p-6"
            >
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-4">
                  {/* Result Icon */}
                  <div className="flex items-center gap-2">
                    {getResultIcon(debate.result)}
                    <span className={`font-semibold ${getResultColor(debate.result)}`}>
                      {debate.result.toUpperCase()}
                    </span>
                  </div>

                  {/* Opponent Info */}
                  <div className="flex items-center gap-3">
                    {debate.opponent.photoURL ? (
                      <img
                        src={debate.opponent.photoURL}
                        alt={debate.opponent.name}
                        className="w-10 h-10 rounded-full"
                      />
                    ) : null}
                  <div>
                      <div className="font-medium text-gray-900 dark:text-white">
                        {debate.opponent.name}
                      </div>
                      <div className="text-sm text-gray-500 dark:text-gray-400">
                        Rating: {debate.opponent.rating}
                      </div>
                    </div>
                  </div>
                </div>

                <div className="flex items-center gap-6 divide-x-4 divide-gray-400 dark:divide-gray-700">
                  {/* Score */}
                  <div className="text-center pr-6">
                    <div className="text-lg font-bold text-gray-900 dark:text-white">
                      {debate.score.user} - {debate.score.opponent}
                    </div>
                    <div className="text-sm text-gray-500 dark:text-gray-400">Score</div>
                  </div>

                  {/* Rating Change */}
                  <div className="text-center px-6">
                    <div className={`text-lg font-bold ${debate.ratingChange > 0 ? 'text-green-600 dark:text-green-400' : debate.ratingChange < 0 ? 'text-red-600 dark:text-red-400' : 'text-yellow-600 dark:text-yellow-400'}`}>
                      {debate.ratingChange > 0 ? '+' : ''}{debate.ratingChange}
                    </div>
                    <div className="text-sm text-gray-500 dark:text-gray-400">Rating</div>
                  </div>

                  {/* Duration */}
                  <div className="text-center px-6">
                    <div className="text-lg font-bold text-gray-900 dark:text-white">
                      {formatMsToMinSec(debate.rawDiff)}
                    </div>
                    <div className="text-sm text-gray-500 dark:text-gray-400">Duration</div>
                  </div>

                  {/* Date */}
                  <div className="text-center pl-6">
                    <div className="text-sm font-medium text-gray-900 dark:text-white">
                      {formatDate(debate.date)}
                    </div>
                    <div className="text-xs text-gray-500 dark:text-gray-400">Date</div>
                  </div>
                </div>
              </div>

              {/* Topic */}
              <div className="mt-4 pt-4 border-t border-gray-200 dark:border-gray-700">
                <div className="flex items-center justify-between">
                  <div>
                    <h3 className="font-semibold text-gray-900 dark:text-white">
                      {debate.topic}
                    </h3>
                    <div className="flex items-center gap-2 mt-1">
                      <span className="px-2 py-1 bg-blue-100 dark:bg-blue-900 text-blue-800 dark:text-blue-200 rounded-full text-xs">
                        {debate.category}
                      </span>
                    </div>
                  </div>
                  
                  <Link
                    to={debate.participants.some((p: any) => p.userId === 'ai_opponent') 
                      ? `/debate/${debate.id}` 
                      : `/custom-debate/${debate.id}`}
                    className="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors text-sm"
                  >
                    View Details
                  </Link>
                </div>
              </div>
            </motion.div>
          ))}
        </motion.div>

        {/* Empty State */}
        {sortedHistory.length === 0 && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            className="text-center py-12"
          >
            <Trophy className="w-16 h-16 text-gray-400 mx-auto mb-4" />
            <h3 className="text-xl font-semibold text-gray-900 dark:text-white mb-2">
              No debates found
            </h3>
            <p className="text-gray-600 dark:text-gray-300 mb-6">
              Start your first debate to see your history here
            </p>
            <Link
              to="/find-debate"
              className="bg-blue-600 text-white px-6 py-3 rounded-lg hover:bg-blue-700 transition-colors"
            >
              Find a Debate
            </Link>
          </motion.div>
        )}
      </div>
    </div>
  );
};

export default HistoryPage;
