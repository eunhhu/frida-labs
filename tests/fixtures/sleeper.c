#include <signal.h>
#ifdef _WIN32
#include <windows.h>
#else
#include <unistd.h>
#endif

static volatile sig_atomic_t running = 1;

static void stop_process(int signal_number) {
  (void)signal_number;
  running = 0;
}

int main(void) {
  signal(SIGINT, stop_process);
  signal(SIGTERM, stop_process);
  while (running) {
#ifdef _WIN32
    Sleep(50);
#else
    pause();
#endif
  }
  return 0;
}
