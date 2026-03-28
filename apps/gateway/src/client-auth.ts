export function resolvePresentedClientAuthToken(
  request: Request,
  input?: {
    searchParams?: URLSearchParams;
    allowQueryParam?: boolean;
  },
): string | null {
  const queryToken =
    input?.allowQueryParam && input.searchParams
      ? input.searchParams.get("clientAuthToken")
      : null;

  return queryToken ?? getBearerToken(request.headers.get("authorization"));
}

export function hasMatchingClientAuthToken(
  presentedToken: string | null | undefined,
  expectedToken: string,
): boolean {
  if (!presentedToken) {
    return false;
  }

  return constantTimeEquals(presentedToken, expectedToken);
}

function getBearerToken(authorizationHeader: string | null): string | null {
  if (!authorizationHeader) {
    return null;
  }

  const match = authorizationHeader.match(/^Bearer\s+(.+)$/i);
  return match?.[1]?.trim() || null;
}

function constantTimeEquals(left: string, right: string): boolean {
  if (left.length !== right.length) {
    return false;
  }

  let mismatch = 0;
  for (let index = 0; index < left.length; index += 1) {
    mismatch |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }

  return mismatch === 0;
}
