#include <signal.h>
#include <unistd.h>

static volatile sig_atomic_t running = 1;

static void stop_process(int signal_number) {
  (void)signal_number;
  running = 0;
}

int main(void) {
  signal(SIGINT, stop_process);
  signal(SIGTERM, stop_process);
  while (running) pause();
  return 0;
}
