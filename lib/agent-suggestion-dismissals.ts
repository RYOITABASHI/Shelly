import AsyncStorage from '@react-native-async-storage/async-storage';

const SEEN_KEY = 'shelly_suggestions_seen';
const THROTTLE_MS = 60_000;

let seenSet: Set<string> | null = null;
let lastSuggestionTime = 0;

export async function loadSeenSuggestions(): Promise<void> {
  try {
    const raw = await AsyncStorage.getItem(SEEN_KEY);
    seenSet = new Set(raw ? JSON.parse(raw) : []);
  } catch {
    seenSet = new Set();
  }
}

export async function shouldShowSuggestion(suggestionId: string): Promise<boolean> {
  if (!seenSet) await loadSeenSuggestions();
  if (seenSet!.has(suggestionId)) return false;
  if (Date.now() - lastSuggestionTime < THROTTLE_MS) return false;
  lastSuggestionTime = Date.now();
  return true;
}

export async function markSuggestionSeen(suggestionId: string): Promise<void> {
  if (!seenSet) await loadSeenSuggestions();
  seenSet!.add(suggestionId);
  await AsyncStorage.setItem(SEEN_KEY, JSON.stringify([...seenSet!]));
}
