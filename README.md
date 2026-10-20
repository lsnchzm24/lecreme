# LeCreme Bakery

Custom cake ordering: customers design a cake and watch it render live, pick a pickup time from the
kitchen's real availability, and reserve with a deposit. The bakery runs everything from `/admin`.

## What's in it

- **Designer** (`/build`): size, tiers, sponge and filling per tier (with an inside cut-away view),
  finish, any color, drip, border, toppings, topper, piped message, dietary options, notes and an
  inspiration photo. Live price, shareable design links, draft saved on the device.
- **Live scheduler**: day capacity in kitchen units (one per tier, plus one for fondant), pickup slots
  with a per-slot limit, lead time that grows with the design, blackout days. A customer's slot is held
  while they pay; unpaid holds release themselves.
- **Checkout**: Stripe Checkout (cards, Apple Pay, Google Pay). Deposit at checkout, balance online or
  in person. Order page with live progress, `.ics` calendar file.
- **Admin** (`/admin`): orders by day with status steps, kitchen notes and in-person payments; calendar
  with capacity and closures; menu prices and visibility; payments report; hours and settings.

## Payments and the platform fee

Stripe Connect destination charges with `on_behalf_of`: the bakery is the merchant of record, so
Stripe Checkout shows the bakery's name and branding and the customer's card statement shows
"LECREME BAKERY". The platform account (yours, `STRIPE_SECRET_KEY`) runs the checkout.

Every online payment splits exactly:

    platform fee = 5% of the payment + Stripe's real processing fee
    bakery gets  = payment - platform fee

Checkout starts with an estimate of Stripe's fee (2.9% + 30¢); right after payment the site reads
Stripe's actual fee and corrects the difference (application fee refund or transfer reversal), so the
platform always nets exactly 5%. In-person payments have no Stripe fee; 5% is recorded as owed.

The bakery connects payouts from **Admin → Payments → Connect payouts with Stripe** (Stripe Express
onboarding, no API keys). Enable Connect in your Stripe dashboard first.

## Railway variables

| Variable | Purpose |
|---|---|
| `ADMIN_PASSWORD` | Admin sign-in (admin is off without it) |
| `SECRET_KEY` | Session signing, any long random string |
| `DATA_DIR` | `/data`, with a volume mounted at `/data` |
| `STRIPE_SECRET_KEY` | Platform account key (`sk_test_` to try) |
| `STRIPE_WEBHOOK_SECRET` | From the webhook at `https://DOMAIN/stripe/webhook` for `checkout.session.completed`, `checkout.session.async_payment_succeeded`, `checkout.session.expired` |
| `PLATFORM_FEE_PCT` | Default `5` |
| `STRIPE_PCT`, `STRIPE_FIXED_CENTS` | First estimate of Stripe's fee, default `2.9` and `30` (corrected to the real fee after payment) |
| `PUBLIC_URL` | e.g. `https://lecremebakery.com` (optional) |
| `BAKERY_PHONE`, `BAKERY_TZ` | Default `786-484-6746`, `America/New_York` |
| `ORDERS_INBOX`, `RESEND_API_KEY`, `RESEND_FROM` | Order emails (optional) |

Without `STRIPE_SECRET_KEY` orders still come in, as requests the bakery confirms by phone.

## Local

```
pip install -r requirements.txt
ADMIN_PASSWORD=test python app.py
```
