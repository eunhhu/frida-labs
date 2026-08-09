#include <stdio.h>

int main(void) {
  if (getchar() == EOF) return 0;
  *((volatile int *)0) = 1;
  return 0;
}
