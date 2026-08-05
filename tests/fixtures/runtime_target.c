#include <inttypes.h>
#include <signal.h>
#include <stdint.h>
#include <stdio.h>
#include <time.h>
#include <unistd.h>

static volatile sig_atomic_t flab_running = 1;

// Deliberately exported, writable fixture state. Runtime tests attach only to
// this process, so memory reads/writes and hooks never touch an unrelated app.
__attribute__((visibility("default"))) volatile uint32_t flab_counter = 1;
__attribute__((visibility("default"))) volatile uint32_t flab_frozen = 7;
__attribute__((visibility("default"))) volatile uint32_t flab_watched = 0;

__attribute__((noinline, visibility("default")))
uint32_t flab_tick(uint32_t input) {
  flab_counter += 1;
  return input + flab_frozen;
}

static void flab_stop(int signal_number) {
  (void)signal_number;
  flab_running = 0;
}

int main(void) {
  const struct timespec interval = { .tv_sec = 0, .tv_nsec = 2 * 1000 * 1000 };
  signal(SIGINT, flab_stop);
  signal(SIGTERM, flab_stop);

  printf(
    "{\"pid\":%d,\"counter\":\"0x%" PRIxPTR "\",\"frozen\":\"0x%" PRIxPTR "\",\"watched\":\"0x%" PRIxPTR "\",\"tick\":\"0x%" PRIxPTR "\"}\n",
    getpid(),
    (uintptr_t)&flab_counter,
    (uintptr_t)&flab_frozen,
    (uintptr_t)&flab_watched,
    (uintptr_t)&flab_tick
  );
  fflush(stdout);

  uint32_t input = 0;
  while (flab_running) {
    input = flab_tick(input);
    if ((flab_counter % 50) == 0) flab_watched += 1;
    nanosleep(&interval, NULL);
  }
  return 0;
}
