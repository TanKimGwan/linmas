/*
 * Reference source for the operator-provisioned IRSA-003 pre-interpreter
 * bootstrap.  Build only for Linux x86_64 with:
 *
 *   cc -nostdlib -static -fno-stack-protector -fno-pie -no-pie \
 *      -Wl,--build-id=none -o irsa003-trusted-bootstrap \
 *      irsa003-trusted-bootstrap.c
 *
 * The resulting ELF has no dynamic interpreter and therefore processes no
 * LD_PRELOAD or LD_LIBRARY_PATH input.  It remains resident as the Python
 * launcher's parent, starts Python with a fixed argv prefix and a complete
 * environment replacement, waits for it, and returns the same exit status.
 * Production paths are compile-time constants.  A deployment must bind the
 * resulting bytes and ownership in the independently managed trust policy.
 */

#if !defined(__linux__) || !defined(__x86_64__)
#error "IRSA-003 bootstrap supports Linux x86_64 only"
#endif

#ifndef LINMAS_PYTHON_PATH
#define LINMAS_PYTHON_PATH "/usr/bin/python3"
#endif

#ifndef LINMAS_LAUNCHER_PATH
#define LINMAS_LAUNCHER_PATH "/usr/libexec/linmas/irsa003-trusted-launch.py"
#endif

#define SYS_READ 0
#define SYS_OPEN 2
#define SYS_CLOSE 3
#define SYS_WRITE 1
#define SYS_RT_SIGACTION 13
#define SYS_RT_SIGPROCMASK 14
#define SYS_KILL 62
#define SYS_SETPGID 109
#define SYS_RT_SIGTIMEDWAIT 128
#define SYS_PRCTL 157
#define SYS_CLOCK_GETTIME 228
#define SYS_CLOSE_RANGE 436
#define SYS_GETPID 39
#define SYS_FORK 57
#define SYS_EXECVE 59
#define SYS_EXIT 60
#define SYS_WAIT4 61
#define EINTR 4
#define MAX_FORWARDED_ARGUMENTS 112

typedef unsigned long usize;

static long syscall0(long number) {
  long result;
  __asm__ volatile("syscall" : "=a"(result) : "a"(number) : "rcx", "r11", "memory");
  return result;
}

static long syscall1(long number, long first) {
  long result;
  __asm__ volatile("syscall" : "=a"(result) : "a"(number), "D"(first) : "rcx", "r11", "memory");
  return result;
}

static long syscall3(long number, long first, long second, long third) {
  long result;
  __asm__ volatile("syscall" : "=a"(result) : "a"(number), "D"(first), "S"(second), "d"(third) : "rcx", "r11", "memory");
  return result;
}

static long syscall4(long number, long first, long second, long third, long fourth) {
  register long r10 __asm__("r10") = fourth;
  long result;
  __asm__ volatile("syscall" : "=a"(result) : "a"(number), "D"(first), "S"(second), "d"(third), "r"(r10) : "rcx", "r11", "memory");
  return result;
}

static usize text_length(const char *value) {
  usize length = 0;
  while (value[length] != '\0') length++;
  return length;
}

static void write_error(const char *value) {
  (void)syscall3(SYS_WRITE, 2, (long)value, (long)text_length(value));
}

static char *decimal_pid(long value, char buffer[24]) {
  usize index = 23;
  buffer[index] = '\0';
  if (value <= 0) return (char *)0;
  while (value > 0 && index > 0) {
    buffer[--index] = (char)('0' + (value % 10));
    value /= 10;
  }
  return &buffer[index];
}

/* Signals are consumed synchronously, including the final-decision handshake.
 * No async handler, libc, dynamic loader, or caller descriptor is involved. */
struct timespec { long sec; long nsec; };
struct sigaction { unsigned long handler, flags, restorer, mask; };
struct siginfo { int signo, error, code, pad, pid, uid; char rest[104]; };
#define BIT(sig) (1UL << ((sig)-1))
#define CANCEL_MASK (BIT(1) | BIT(2) | BIT(15))
#define WAIT_MASK (CANCEL_MASK | BIT(17) | BIT(10))

static long milliseconds(void) {
  struct timespec value;
  if (syscall3(SYS_CLOCK_GETTIME, 1, (long)&value, 0) < 0) return -1;
  return value.sec * 1000 + value.nsec / 1000000;
}

static int normalize_signals(unsigned long mask) {
  struct sigaction action = {0, 0, 0, 0};
  for (long sig = 1; sig <= 64; sig++) {
    if (sig == 9 || sig == 19) continue;
    if (syscall4(SYS_RT_SIGACTION, sig, (long)&action, 0, 8) < 0) return 0;
  }
  return syscall4(SYS_RT_SIGPROCMASK, 2, (long)&mask, 0, 8) == 0;
}

/* Reparented descendants are bounded and reaped even if their session changed.
 * Bubblewrap's private PID namespace also destroys its children on init death. */
static void kill_adopted(long own_pid) {
  char number[24], filename[96], bytes[16384];
  char *n = decimal_pid(own_pid, number);
  const char *parts[] = {"/proc/self/task/", n, "/children", (char *)0};
  usize at = 0;
  for (int i = 0; parts[i]; i++)
    for (usize j = 0; parts[i][j]; j++) filename[at++] = parts[i][j];
  filename[at] = 0;
  long fd = syscall3(SYS_OPEN, (long)filename, 0, 0);
  if (fd < 0) return;
  long count = syscall3(SYS_READ, fd, (long)bytes, sizeof(bytes));
  (void)syscall1(SYS_CLOSE, fd);
  long pid = 0;
  for (long i = 0; i <= count; i++) {
    if (i < count && bytes[i] >= '0' && bytes[i] <= '9') pid = pid * 10 + bytes[i] - '0';
    else if (pid > 0) { (void)syscall3(SYS_KILL, pid, 9, 0); pid = 0; }
  }
}

static long bootstrap_main(long *initial_stack) {
  long argc = initial_stack[0];
  char **argv = (char **)&initial_stack[1];
  char *child_argv[MAX_FORWARDED_ARGUMENTS + 8];
  char pid_buffer[24];
  static char *const child_environment[] = {
    "PATH=/usr/bin:/bin", "LANG=C.UTF-8", "LC_ALL=C.UTF-8",
    "LINMAS_IRSA003_BOOTSTRAP=static-empty-environment-v1", (char *)0
  };
  if (argc < 1 || argc - 1 > MAX_FORWARDED_ARGUMENTS) return 64;
  /* Unsupported close_range/subreaper kernels fail closed. */
  if (!normalize_signals(WAIT_MASK)
      || syscall3(SYS_CLOSE_RANGE, 3, 0xffffffffUL, 0) < 0
      || syscall3(SYS_PRCTL, 36, 1, 0) < 0) return 70;
  long own_pid = syscall0(SYS_GETPID);
  child_argv[0] = (char *)LINMAS_PYTHON_PATH;
  child_argv[1] = "-I"; child_argv[2] = "-E";
  child_argv[3] = (char *)LINMAS_LAUNCHER_PATH;
  child_argv[4] = "--bootstrap-parent-pid";
  child_argv[5] = decimal_pid(own_pid, pid_buffer);
  for (long i = 1; i < argc; i++) child_argv[i + 5] = argv[i];
  child_argv[argc + 5] = (char *)0;
  long child = syscall0(SYS_FORK);
  if (child == 0) {
    if (syscall3(SYS_SETPGID, 0, 0, 0) < 0
        || syscall3(SYS_PRCTL, 1, 9, 0) < 0
        || syscall0(110) != own_pid || !normalize_signals(0))
      (void)syscall1(SYS_EXIT, 70);
    (void)syscall3(SYS_EXECVE, (long)LINMAS_PYTHON_PATH, (long)child_argv, (long)child_environment);
    write_error("IRSA-003 bootstrap could not exec the fixed Python launcher\n");
    (void)syscall1(SYS_EXIT, 70);
    for (;;) {}
  }
  if (child < 0) return 70;
  (void)syscall3(SYS_SETPGID, child, child, 0);
  long start = milliseconds(), cancelling = -1, cleanup = -1;
  int cancel_signal = 0, finalizing = 0, main_done = 0, status = 0, result = 70;
  unsigned long signals = WAIT_MASK, cancels = CANCEL_MASK;
  struct timespec pause = {0, 20000000}, immediate = {0, 0};
  while (1) {
    long waited;
    while ((waited = syscall4(SYS_WAIT4, -1, (long)&status, 1, 0)) > 0) {
      if (waited == child) {
        main_done = 1;
        result = (status & 0x7f) == 0 ? (status >> 8) & 0xff : 128 + (status & 0x7f);
        cleanup = milliseconds();
        (void)syscall3(SYS_KILL, -child, 9, 0);
      }
    }
    if (main_done) {
      if (waited == -10) return cancel_signal ? 128 + cancel_signal : result;
      kill_adopted(own_pid);
      if (milliseconds() - cleanup > 3000) return 70;
    }
    struct siginfo info;
    long sig = syscall4(SYS_RT_SIGTIMEDWAIT, (long)&signals, (long)&info, (long)&pause, 8);
    if (!main_done && sig == 10 && info.pid == child && !finalizing && !cancel_signal) {
      /* Linearization: all queued cancellation precedes acceptance. Once this
       * gate is granted, commit/fsync is bounded and cancellation is deferred.
       * A write failure still fails closed; the grant alone is not success. */
      long pending = syscall4(SYS_RT_SIGTIMEDWAIT, (long)&cancels, (long)&info, (long)&immediate, 8);
      if (pending > 0) sig = pending;
      else { finalizing = 1; (void)syscall3(SYS_KILL, child, 12, 0); }
    }
    if (!main_done && !finalizing && !cancel_signal && (sig == 1 || sig == 2 || sig == 15)) {
      cancel_signal = (int)sig; cancelling = milliseconds();
      (void)syscall3(SYS_KILL, -child, sig, 0);
    }
    long now = milliseconds();
    if (now < 0 || now - start > 180000) {
      if (!cancel_signal) cancel_signal = 14;
      (void)syscall3(SYS_KILL, -child, 9, 0); kill_adopted(own_pid);
      if (now - start > 185000) return 70;
    }
    if (cancel_signal && cancelling >= 0 && now - cancelling > 2000) {
      (void)syscall3(SYS_KILL, -child, 9, 0); kill_adopted(own_pid);
    }
  }
}

__asm__(
  ".global _start\n"
  "_start:\n"
  "mov %rsp, %rdi\n"
  "andq $-16, %rsp\n"
  "call bootstrap_main\n"
  "mov %rax, %rdi\n"
  "mov $60, %rax\n"
  "syscall\n"
);
