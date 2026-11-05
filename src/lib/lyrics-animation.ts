/** Keep browser animations on the lyric timeline, including exact word boundaries. */
export function syncLyricAnimation(animation: Animation, expected: number, duration: number,
  moving: boolean, reducedMotion: boolean): void {
  if (expected >= duration) {
    if (animation.playState !== 'paused') animation.pause();
    if (animation.currentTime !== duration) animation.currentTime = duration;
    return;
  }
  if (!moving || reducedMotion) {
    if (animation.playState !== 'paused') animation.pause();
    if (animation.currentTime !== expected) animation.currentTime = expected;
    return;
  }
  if (Math.abs(Number(animation.currentTime ?? 0) - expected) > 80) {
    animation.currentTime = expected;
  }
  if (animation.playState !== 'running') animation.play();
}
