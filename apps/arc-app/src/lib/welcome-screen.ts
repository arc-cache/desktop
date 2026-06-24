export type TimeBucket = "lateNight" | "morning" | "afternoon" | "evening";

export interface ContinueMessage {
  headline: string;
  subtitle: string;
  accent: string;
}

const ANYTIME_CONTINUE_MESSAGES: readonly ContinueMessage[] = [
  {
    headline: "Continue building",
    subtitle: "Your threads are warm. Pick one and keep shipping.",
    accent: "oklch(0.62 0.18 185)",
  },
  {
    headline: "Welcome back",
    subtitle: "The repo missed you for several whole seconds.",
    accent: "oklch(0.66 0.16 32)",
  },
  {
    headline: "Back at it, menace",
    subtitle: "Choose a thread and apply tasteful chaos.",
    accent: "oklch(0.7 0.17 145)",
  },
  {
    headline: "One more tiny change",
    subtitle: "Famous last words. Your threads are waiting.",
    accent: "oklch(0.72 0.14 260)",
  },
];

const TIME_AWARE_CONTINUE_MESSAGES: Record<TimeBucket, readonly ContinueMessage[]> = {
  lateNight: [
    {
      headline: "Hello, night owl",
      subtitle: "Your best ideas and worst commit messages happen now.",
      accent: "oklch(0.7 0.15 250)",
    },
    {
      headline: "Midnight debug club",
      subtitle: "The stack trace is glowing gently in the dark.",
      accent: "oklch(0.68 0.18 290)",
    },
    {
      headline: "Moonlight merge pending",
      subtitle: "Pick up where you left off before the birds clock in.",
      accent: "oklch(0.74 0.13 215)",
    },
  ],
  morning: [
    {
      headline: "Good morning, builder",
      subtitle: "Fresh tab, fresh coffee, same huge TODO list.",
      accent: "oklch(0.76 0.16 78)",
    },
    {
      headline: "Rise and refactor",
      subtitle: "Your threads are awake before some of your teammates.",
      accent: "oklch(0.73 0.17 110)",
    },
    {
      headline: "Morning commit energy",
      subtitle: "Start with the easy win before the meetings find you.",
      accent: "oklch(0.78 0.15 48)",
    },
  ],
  afternoon: [
    {
      headline: "Welcome back, sunshine",
      subtitle: "Prime hour for turning half-finished ideas into features.",
      accent: "oklch(0.74 0.18 58)",
    },
    {
      headline: "Afternoon sprint mode",
      subtitle: "The code is warm and your threads are lined up.",
      accent: "oklch(0.68 0.19 28)",
    },
    {
      headline: "Post-lunch patch attack",
      subtitle: "Pick a thread and make the roadmap more believable.",
      accent: "oklch(0.75 0.16 135)",
    },
  ],
  evening: [
    {
      headline: "Evening shift engaged",
      subtitle: "Quiet hours. Strong focus. Mild gremlin energy.",
      accent: "oklch(0.67 0.17 15)",
    },
    {
      headline: "Twilight build session",
      subtitle: "A nice time to ship something clever and unnecessary.",
      accent: "oklch(0.69 0.18 335)",
    },
    {
      headline: "Welcome back after hours",
      subtitle: "Your threads are ready for that definitely quick check-in.",
      accent: "oklch(0.72 0.15 210)",
    },
  ],
};

function getTimeBucket(date: Date): TimeBucket {
  const hour = date.getHours();
  if (hour < 5) {
    return "lateNight";
  }
  if (hour < 12) {
    return "morning";
  }
  if (hour < 18) {
    return "afternoon";
  }
  return "evening";
}

function pickRandomMessage(
  messages: readonly ContinueMessage[],
  previous?: ContinueMessage,
): ContinueMessage {
  if (messages.length === 1) {
    return messages[0];
  }

  let nextMessage = messages[Math.floor(Math.random() * messages.length)];
  if (!previous) {
    return nextMessage;
  }

  let attempts = 0;
  while (
    attempts < 6 &&
    nextMessage.headline === previous.headline &&
    nextMessage.subtitle === previous.subtitle
  ) {
    nextMessage = messages[Math.floor(Math.random() * messages.length)];
    attempts += 1;
  }

  return nextMessage;
}

function getContinueMessageHourKey(date: Date): string {
  return [
    date.getFullYear(),
    date.getMonth(),
    date.getDate(),
    date.getHours(),
  ].join(":");
}

export function getContinueMessage(
  previous?: ContinueMessage,
  now: Date = new Date(),
): ContinueMessage {
  const bucket = getTimeBucket(now);
  return pickRandomMessage(
    [...TIME_AWARE_CONTINUE_MESSAGES[bucket], ...ANYTIME_CONTINUE_MESSAGES],
    previous,
  );
}

export function getNextContinueMessageDelay(now: Date = new Date()): number {
  const nextHour = new Date(now);
  nextHour.setHours(now.getHours() + 1, 0, 0, 0);
  return Math.max(nextHour.getTime() - now.getTime(), 60_000);
}

export function shouldRefreshContinueMessage(
  lastRefreshedAt: Date,
  now: Date = new Date(),
): boolean {
  return getContinueMessageHourKey(lastRefreshedAt) !== getContinueMessageHourKey(now);
}
