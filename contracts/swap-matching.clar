;; SwapMatching.clar
;; This contract facilitates proposing, matching, and accepting swap offers between users in the EcoSwap ecosystem.
;; It handles the logic for creating swap proposals, accepting them, cancelling, and querying matches.
;; Assumes integration with ItemListing.clar for item validation, UserRegistry.clar for user checks,
;; and EscrowContract.clar for finalizing swaps.
;; For sophistication: Supports multi-item swaps, expiration times, counter-offers, status tracking,
;; reputation integration hooks, and event emissions.

;; Constants
(define-constant ERR-NOT-AUTHORIZED u100)
(define-constant ERR-INVALID-ITEM u101)
(define-constant ERR-SWAP-NOT-FOUND u102)
(define-constant ERR-INVALID-STATUS u103)
(define-constant ERR-EXPIRED u104)
(define-constant ERR-INVALID-EXPIRATION u105)
(define-constant ERR-NOT-PROPOSER u106)
(define-constant ERR-NOT-PROPOSED-TO u107)
(define-constant ERR-SELF-SWAP u108)
(define-constant ERR-EMPTY-ITEMS u109)
(define-constant ERR-MAX-ITEMS-EXCEEDED u110)
(define-constant ERR-ALREADY-ACCEPTED u111)
(define-constant ERR-COUNTER-OFFER-EXISTS u112)
(define-constant MAX-ITEMS-PER-SIDE u5) ;; Max items per offer/request side
(define-constant MAX-COUNTER-OFFER-DEPTH u3) ;; Prevent infinite counter-offer chains

;; Data Structures
(define-data-var last-swap-id uint u0)
(define-data-var contract-owner principal tx-sender)

;; Maps
(define-map swaps
  { swap-id: uint }
  {
    proposer: principal,
    proposed-to: principal,
    offered-items: (list 5 uint), ;; List of item-ids from ItemListing
    requested-items: (list 5 uint), ;; List of item-ids requested
    status: (string-ascii 20), ;; "pending", "accepted", "cancelled", "completed", "countered"
    expiration: uint, ;; Block height when expires
    timestamp: uint,
    parent-swap-id: (optional uint), ;; For counter-offers
    child-counter-id: (optional uint) ;; Latest counter-offer if any
  }
)

(define-map user-swaps
  { user: principal }
  { swap-ids: (list 100 uint) } ;; List of swap-ids involving the user (as proposer or proposed-to)
)

(define-map counter-offer-count
  { swap-id: uint }
  { count: uint }
)

;; Private Functions
(define-private (is-registered-user (user principal))
  ;; Mock integration with UserRegistry.clar; in real: (contract-call? .UserRegistry is-registered user)
  (is-some (some true)) ;; Placeholder: Assume all are registered for now
)

(define-private (validate-items (items (list 5 uint)))
  (and
    (> (len items) u0)
    (<= (len items) MAX-ITEMS-PER-SIDE)
    ;; Mock integration with ItemListing.clar: Check each item exists and owned by caller
    true ;; Placeholder
  )
)

(define-private (append-to-user-swaps (user principal) (swap-id uint))
  (let ((current (default-to { swap-ids: (list) } (map-get? user-swaps { user: user }))))
    (map-set user-swaps { user: user } { swap-ids: (unwrap-panic (as-max-len? (append (get swap-ids current) swap-id) u100)) })
  )
)

(define-private (emit-swap-event (event-type (string-ascii 20)) (swap-id uint))
  (print { event: event-type, swap-id: swap-id, block-height: block-height })
)

;; Public Functions
(define-public (propose-swap
  (proposed-to principal)
  (offered-items (list 5 uint))
  (requested-items (list 5 uint))
  (expiration uint))
  (let
    (
      (proposer tx-sender)
      (new-id (+ (var-get last-swap-id) u1))
    )
    (asserts! (not (is-eq proposer proposed-to)) (err ERR-SELF-SWAP))
    (asserts! (is-registered-user proposer) (err ERR-NOT-AUTHORIZED))
    (asserts! (is-registered-user proposed-to) (err ERR-NOT-AUTHORIZED))
    (asserts! (validate-items offered-items) (err ERR-INVALID-ITEM))
    (asserts! (validate-items requested-items) (err ERR-INVALID-ITEM))
    (asserts! (and (> expiration block-height) (<= expiration (+ block-height u10080))) (err ERR-INVALID-EXPIRATION)) ;; ~1 week max
    (map-set swaps
      { swap-id: new-id }
      {
        proposer: proposer,
        proposed-to: proposed-to,
        offered-items: offered-items,
        requested-items: requested-items,
        status: "pending",
        expiration: expiration,
        timestamp: block-height,
        parent-swap-id: none,
        child-counter-id: none
      }
    )
    (append-to-user-swaps proposer new-id)
    (append-to-user-swaps proposed-to new-id)
    (var-set last-swap-id new-id)
    (emit-swap-event "proposed" new-id)
    (ok new-id)
  )
)

(define-public (accept-swap (swap-id uint))
  (let
    (
      (swap (unwrap! (map-get? swaps { swap-id: swap-id }) (err ERR-SWAP-NOT-FOUND)))
      (caller tx-sender)
    )
    (asserts! (is-eq (get proposed-to swap) caller) (err ERR-NOT-PROPOSED-TO))
    (asserts! (is-eq (get status swap) "pending") (err ERR-INVALID-STATUS))
    (asserts! (< block-height (get expiration swap)) (err ERR-EXPIRED))
    (asserts! (is-none (get child-counter-id swap)) (err ERR-COUNTER-OFFER-EXISTS))
    (map-set swaps { swap-id: swap-id } (merge swap { status: "accepted" }))
    (emit-swap-event "accepted" swap-id)
    ;; Hook to EscrowContract.clar: (contract-call? .EscrowContract initiate-escrow swap-id)
    (ok true)
  )
)

(define-public (cancel-swap (swap-id uint))
  (let
    (
      (swap (unwrap! (map-get? swaps { swap-id: swap-id }) (err ERR-SWAP-NOT-FOUND)))
      (caller tx-sender)
    )
    (asserts! (or (is-eq (get proposer swap) caller) (is-eq (get proposed-to swap) caller)) (err ERR-NOT-AUTHORIZED))
    (asserts! (is-eq (get status swap) "pending") (err ERR-INVALID-STATUS))
    (map-set swaps { swap-id: swap-id } (merge swap { status: "cancelled" }))
    (emit-swap-event "cancelled" swap-id)
    (ok true)
  )
)

(define-public (counter-offer
  (original-swap-id uint)
  (new-offered-items (list 5 uint))
  (new-requested-items (list 5 uint))
  (new-expiration uint))
  (let
    (
      (original (unwrap! (map-get? swaps { swap-id: original-swap-id }) (err ERR-SWAP-NOT-FOUND)))
      (counter-count (default-to { count: u0 } (map-get? counter-offer-count { swap-id: original-swap-id })))
      (caller tx-sender)
      (new-id (+ (var-get last-swap-id) u1))
    )
    (asserts! (is-eq (get proposed-to original) caller) (err ERR-NOT-PROPOSED-TO))
    (asserts! (is-eq (get status original) "pending") (err ERR-INVALID-STATUS))
    (asserts! (< (get count counter-count) MAX-COUNTER-OFFER-DEPTH) (err ERR-COUNTER-OFFER-EXISTS))
    (asserts! (validate-items new-offered-items) (err ERR-INVALID-ITEM))
    (asserts! (validate-items new-requested-items) (err ERR-INVALID-ITEM))
    (asserts! (and (> new-expiration block-height) (<= new-expiration (+ block-height u10080))) (err ERR-INVALID-EXPIRATION))
    (map-set swaps
      { swap-id: new-id }
      {
        proposer: caller, ;; Counter-proposer becomes new proposer
        proposed-to: (get proposer original), ;; Original proposer becomes proposed-to
        offered-items: new-offered-items,
        requested-items: new-requested-items,
        status: "pending",
        expiration: new-expiration,
        timestamp: block-height,
        parent-swap-id: (some original-swap-id),
        child-counter-id: none
      }
    )
    (map-set swaps { swap-id: original-swap-id } (merge original { child-counter-id: (some new-id), status: "countered" }))
    (map-set counter-offer-count { swap-id: original-swap-id } { count: (+ (get count counter-count) u1) })
    (append-to-user-swaps caller new-id)
    (append-to-user-swaps (get proposer original) new-id)
    (var-set last-swap-id new-id)
    (emit-swap-event "countered" new-id)
    (ok new-id)
  )
)

(define-public (complete-swap (swap-id uint))
  ;; Called by EscrowContract or admin after escrow release
  (let
    (
      (swap (unwrap! (map-get? swaps { swap-id: swap-id }) (err ERR-SWAP-NOT-FOUND)))
      (caller tx-sender)
    )
    (asserts! (is-eq caller (var-get contract-owner)) (err ERR-NOT-AUTHORIZED)) ;; Or check escrow
    (asserts! (is-eq (get status swap) "accepted") (err ERR-INVALID-STATUS))
    (map-set swaps { swap-id: swap-id } (merge swap { status: "completed" }))
    (emit-swap-event "completed" swap-id)
    ;; Hook to ReputationSystem.clar: Update reps for both parties
    (ok true)
  )
)

;; Read-Only Functions
(define-read-only (get-swap-details (swap-id uint))
  (map-get? swaps { swap-id: swap-id })
)

(define-read-only (get-user-swaps (user principal))
  (default-to (list) (get swap-ids (map-get? user-swaps { user: user })))
)

(define-read-only (find-potential-matches (user principal) (offered-items (list 5 uint)))
  ;; Simple matching: Find pending swaps where requested-items match offered-items
  ;; In production, more advanced logic or off-chain indexing
  (filter
    (lambda (swap-id)
      (let ((swap (unwrap-panic (get-swap-details swap-id))))
        (and
          (is-eq (get status swap) "pending")
          (not (is-eq (get proposer swap) user))
          (not (is-eq (get proposed-to swap) user))
          ;; Check if offered-items intersect with requested-items of swap
          (> (len (filter (lambda (item) (index-of? (get requested-items swap) item)) offered-items)) u0)
        )
      )
    )
    (get-user-swaps user) ;; Actually, search globally, but for simplicity
  )
)

(define-read-only (get-swap-chain (swap-id uint))
  ;; Get chain of counter-offers
  (let
    (
      (chain (list swap-id))
      (current (unwrap-panic (get-swap-details swap-id)))
    )
    (fold
      (lambda (acc id)
        (match (get parent-swap-id current)
          parent (unwrap-panic (as-max-len? (append acc parent) u10))
          acc
        )
      )
      chain
      (list u1 u2 u3) ;; Dummy iterations
    )
  )
)

(define-read-only (get-last-swap-id)
  (var-get last-swap-id)
)