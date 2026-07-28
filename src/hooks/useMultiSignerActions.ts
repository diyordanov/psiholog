/**
 * useMultiSignerActions.ts
 * Тънък React hook около signingRequestService.ts — data fetching + mutations
 * за signing_requests, ползван от DocumentList/SigningRequestStatus/
 * CancelSigningRequestButton (Ден 5 Owner UI).
 */
import { useCallback, useMemo } from 'react';
import {
  cancelSigningRequest, listSigningRequests, getSigningRequestDetails,
} from '../lib/signingRequestService';
import type { SigningRequestWithRecipients } from '../lib/types';

export interface MultiSignerActions {
  cancel: (requestId: string) => Promise<void>;
  listSigningRequests: () => Promise<SigningRequestWithRecipients[]>;
  getSigningRequestDetails: (requestId: string) => Promise<SigningRequestWithRecipients>;
}

export function useMultiSignerActions(userId: string): MultiSignerActions {
  const cancel = useCallback(
    (requestId: string) => cancelSigningRequest(requestId, userId),
    [userId],
  );
  const list = useCallback(() => listSigningRequests(), []);
  const getDetails = useCallback(
    (requestId: string) => getSigningRequestDetails(requestId),
    [],
  );

  // useMemo — стабилна object референция между render-ите (иначе всеки
  // caller, ползващ връщания обект като useCallback/useEffect dependency,
  // би влязъл в infinite loop, защото plain object literal е нов всеки render).
  return useMemo(
    () => ({ cancel, listSigningRequests: list, getSigningRequestDetails: getDetails }),
    [cancel, list, getDetails],
  );
}
