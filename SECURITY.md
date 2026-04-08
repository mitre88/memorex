# Security Policy

## Overview

Memorex implements multiple security layers to protect user data and prevent abuse. This document outlines the security measures in place and known considerations.

## Security Measures

### Data Protection

| Feature               | Implementation                            |
| --------------------- | ----------------------------------------- |
| File Permissions      | Database: `0o600` (owner read/write only) |
| Directory Permissions | `~/.memorex/`: `0o700` (owner only)       |
| Session File          | `0o600` permissions enforced              |

### Input Validation

All inputs are validated using Zod schemas with additional security checks:

```typescript
// Query sanitization - prevents FTS5 injection
sanitizeFtsQuery(query: string): string
// - Escapes: " * ( ) ^ - ~
// - Removes boolean operators: AND OR NOT NEAR
// - Limits length to 200 characters

// Path validation - prevents directory traversal
isValidProjectPath(path: string): boolean
// - Rejects null bytes
// - Validates path depth
// - Restricts to home directory

// Tag validation
validateTags(tags: string[]): boolean
// - Max 20 tags
// - Max 50 chars per tag
// - Rejects control characters
```

### Race Condition Protection

Session operations use atomic file locking:

```typescript
// mkdir-based locking (atomic on most filesystems)
acquireLock(lockDir: string): boolean
```

This ensures concurrent access to session counters is safe.

### Resource Limits

| Limit             | Value      | Purpose                   |
| ----------------- | ---------- | ------------------------- |
| Max memories      | 200        | Prevents unbounded growth |
| Saves per session | 5          | Rate limiting             |
| Max body length   | 1500 chars | Storage limits            |
| Max query length  | 200 chars  | DoS prevention            |
| Max tags          | 20         | Input validation          |
| Session TTL       | 4 hours    | Automatic reset           |

## Threat Model

### In Scope

- Local data protection (file permissions)
- Input validation and sanitization
- Resource exhaustion prevention
- Concurrent access safety

### Out of Scope

- Network security (local-only application)
- Encryption at rest (relies on OS permissions)
- Multi-user isolation (single-user design)

## Known Limitations

1. **Lock Persistence**: If the process dies while holding a lock, it may persist until manual cleanup
2. **Error Silencing**: Some permission errors are silently caught to ensure functionality
3. **No Encryption**: Data is stored in plaintext SQLite (protected by OS permissions)

## Reporting Security Issues

If you discover a security vulnerability, please:

1. DO NOT open a public issue
2. Email the maintainer directly
3. Allow time for response before public disclosure

## Security Checklist

- [x] Input validation on all entry points
- [x] SQL injection prevention (parameterized queries)
- [x] FTS5 injection prevention (query sanitization)
- [x] Path traversal prevention
- [x] Resource limits enforced
- [x] File permissions restricted
- [x] Race condition protection
- [x] Error handling without information leakage
