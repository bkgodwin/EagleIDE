def _ide_input(prompt=""):
    if prompt:
        sys.stdout.write(str(prompt))
        sys.stdout.flush()
    sys.stdout.write("{INPUT_TOKEN}\n")
    sys.stdout.flush()
    line = sys.stdin.readline()
    user_input = line.rstrip("\n")
    sys.stdout.write(user_input + "\n")
    sys.stdout.flush()
    return user_input
