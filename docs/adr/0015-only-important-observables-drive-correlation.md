# Only Important Observables drive Correlation

Correlation related an Alert to a Case by every Observable they shared, unless an Admin had put it on the Ignored list. In practice Alerts and Cases share many Observables that mean nothing (common resolvers, CDNs, the Organization's own domains, popular hashes), and each one adds a relationship. The Ignored list asks Admins to chase that noise one value at a time, after it has already cluttered every Case's Related Alerts. So Correlation now works the other way round for Observables: only an Observable a Member has marked **Important** relates an Alert to a Case.

- **Organization-wide, on the Observable.** Like the Ignored list, the mark belongs to the Observable, held once per Organization, not to one Case: it is set from the Observable's right-click menu, a Case's row menu, the Enrichment panel or its page, none of which need a Case. Marking one the Organization doesn't hold yet adds it first.
- **Any Member marks and unmarks.** Spotting what matters is everyday Case work, not configuration, so Analysts may do it; Guests may not, and are never told.
- **Every Correlation.** The rule applies to the Case's Related Alerts, the Alert's suggested Cases and the Alert queue's marker alike (`sharedLinks`), so an Alert never points at a Case that doesn't list it back.
- **Assets need no marking.** Hosts and accounts, matched by name, Falcon device or Identity Protection identity (ADR 0009), still drive Correlation as before.
- **Ignored still wins.** An Observable that is both Important and Ignored drives nothing.
- **Kept and Audit Logged.** Each mark is a row in `important_observables` that unmarking ends and keeps (ADR 0003), and each is recorded in the Organization Audit Log as `important_observable.added` or `important_observable.removed`.

## Considered Options

- **Per-Case marks**: rejected. The menus that offer the mark often have no Case, and a value that matters on one Case matters on the next.
- **A threshold on how often an Observable occurs**: rejected. Frequency is a poor proxy: a real C2 domain can recur across many Alerts, and a harmless one can occur once.
- **Admins only, as for the Ignored list**: rejected. It would make Correlation wait on an Admin for every new indicator.

## Consequences

- After this change no Observable is Important, so Correlation runs on Assets alone until Members mark what matters.
