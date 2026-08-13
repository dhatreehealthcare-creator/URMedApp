# Notification channel policy

Policy version: `URMED-NOTIFICATIONS-2026.1`

URMED applies decision D-11 consistently to customer and vendor profiles:

- In-app notifications are the durable default and cannot be disabled for essential transactional or safety categories.
- Reminder and marketing in-app notifications can be disabled. Enabling reminders requires the latest `health_reminders` consent; enabling marketing requires the latest `marketing` consent.
- Email is off by default. It is eligible only when the live account email is provider-verified and the authenticated profile explicitly enables that category. Reminder email additionally requires the latest `health_reminders` consent; marketing email additionally requires the latest `marketing` consent.
- SMS is unavailable and always disabled. It must not be enabled until URMED has a supported provider, an explicit channel-specific consent contract, abuse controls, and durable delivery evidence.
- Preferences belong only to the authenticated live `account_profiles.id`; recovered customer records are never consulted.
- Each category stores an IANA time zone. Reminder scheduling evaluates pill and refill dates/times in the profile's reminder-category zone. Invalid zones are rejected; the conservative migration default is `Asia/Kolkata`.
- Preference changes use optimistic versions. A successful state change and its immutable audit event commit atomically; identical retries are no-ops.

Migration `0047` creates four conservative rows for each existing active profile. Transactional and safety in-app delivery is enabled; optional reminder and marketing delivery and all external channels remain disabled. New profiles receive the same effective defaults even before they first save a preference.

P5-05 defines eligibility only. It does not introduce a provider outbox, retry delivery, bounce handling, or SMS integration; those remain P5-06/provider work.
