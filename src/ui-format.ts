export function buildProgressDots(total: number, currentIndex: number, answeredIndexes: Set<number>): string[] {
  return Array.from({ length: total }, (_, index) => {
    if (index === currentIndex) return "●";
    if (answeredIndexes.has(index)) return "●";
    return "○";
  });
}

export function clampContentWidth(width: number, maxWidth = 96, horizontalPadding = 4): number {
  return Math.max(24, Math.min(maxWidth, width - horizontalPadding));
}

export function centerBox(width: number, boxWidth: number): string {
  return " ".repeat(Math.max(0, Math.floor((width - boxWidth) / 2)));
}
