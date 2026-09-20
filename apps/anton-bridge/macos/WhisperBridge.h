#ifndef WHISPER_BRIDGE_H
#define WHISPER_BRIDGE_H

// Exposes the vendored whisper.cpp C API to the Swift sources compiled by the
// bare `swiftc` invocation in scripts/build-anton-macos.ts (imported via
// `-import-objc-header`). Headers are staged under vendor/include by the
// vendor build; the static libs live under vendor/lib.
#include "whisper.h"

#endif /* WHISPER_BRIDGE_H */
