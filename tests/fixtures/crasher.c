#include <signal.h>
#include <unistd.h>

static volatile sig_atomic_t crash_requested = 0;
static volatile sig_atomic_t running = 1;

static void request_crash(int signal_number) {
  (void)signal_number;
  crash_requested = 1;
}

static void stop_process(int signal_number) {
  (void)signal_number;
  running = 0;
}

int main(void) {
  signal(SIGUSR1, request_crash);
  signal(SIGINT, stop_process);
  signal(SIGTERM, stop_process);
  while (running && !crash_requested) pause();
  if (crash_requested) raise(SIGBUS);
  return 0;
}
