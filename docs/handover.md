# Sunshine Gadgets POS — how to use it

A short guide for the shop. No technical knowledge needed.

There are two screens. **Sales** is for the counter. **Analytics** is for
the owner and is behind a password.

---

## Day one: make the product list yours

The app starts with six example products — Smartphone, Laptop, Phone
charger, Screen guard, Bluetooth speaker, Phone case. They are there so the
screen isn't empty on the first day. They are examples, not your stock.

You have two ways to deal with each one:

- **Rename it into something you actually sell.** Tap **Edit** on the tile,
  change the name and price, tap **Save changes**. This is usually the
  better option for the ones that are close to your real stock.
- **Delete it.** Tap **Edit** on the tile, then **Delete**, then
  **Yes, delete**.

Do this before you start recording real sales, so your reports are clean
from the start.

**To add your own products:** tap **+ New product** at the top, fill in the
name, category, price and how many you have in stock right now, pick an
icon, and tap **Save product**.

---

## Recording a sale

1. Tap the product tile.
2. Set the quantity.
3. The price is filled in for you — change it if you gave a discount.
4. Choose **Paid now** or **Pay later**.
   - **Pay later** asks for the customer's name (required) and phone
     (optional). You can also enter a part-payment if they paid something.
5. Tap **Record sale**.

The stock count on the tile goes down automatically.

**If a product is out of stock, the app will not let you sell it.** This is
deliberate — it stops the books showing stock you don't have. Record the
delivery first (see below), then make the sale.

---

## Restocking

When new goods arrive, tap **+ Stock** on that product's tile, enter how
many units came in, and save. The tile updates immediately.

Never adjust stock by editing the product. Always use **+ Stock**, because
the app keeps a running history of every unit in and out — that history is
what makes the stock figure trustworthy, and what lets two phones both
record deliveries without the numbers fighting each other.

---

## Editing or deleting a product

Tap **Edit** on any tile. You can change:

- the name
- the price
- the icon
- the low-stock warning level (when to show the "Low" badge)

Tap **Save changes**.

**Two things you cannot change:** the category, and the stock count. The
category is fixed because sales already recorded were recorded under the
old category, and changing it would quietly rewrite past reports. Stock is
changed with **+ Stock**, not here.

**Deleting.** Edit → **Delete** → **Yes, delete**. The product disappears
from the sales screen on this device and on every other device the next
time they connect.

Deleting is safe for your records: **past sales of that product are kept**
and still count toward your revenue and reports. You are removing it from
the counter screen, not erasing its history. There is no way to undo a
delete from the screen, so if you are unsure, it costs nothing to leave the
product there.

---

## The Analytics screen (owner)

Open **Analytics** from the top of the sales screen.

- **The first time**, it asks you to set a password. Choose one and keep it
  safe.
- **It asks again every single time the page is opened or refreshed.** That
  is on purpose, so a staff member picking up the tablet cannot see the
  money screens. It is not a fault.
- Each device has its own password. Setting it on the counter tablet does
  not set it on the owner's phone.

What you get: revenue and number of sales for any date range, how that
compares with the period before, a 30-day trend, your best-selling
products, stock value and low-stock warnings, and the **pay-later ledger**
of who still owes you.

**Recording a repayment:** find the customer in the pay-later list and tap
**Record payment**. Enter the amount — part payments are fine. When the
balance reaches zero the row leaves the ledger automatically.

If you forget the analytics password, it can be reset, but it needs someone
technical for two minutes — the instructions are in the project README
under "Admin password".

---

## Working without internet

**The app works completely offline.** Record sales all day with no
connection; nothing is lost and nothing is queued up in a way you have to
think about.

Watch the small pill at the top of the screen:

| It says | It means |
|---|---|
| **Synced** | Everything is saved to the shared database. |
| **Syncing…** | Sending right now. |
| **Offline — will sync** | No connection. Your work is saved on this device and will go up by itself when the network returns. |
| **Offline only** | Cloud sync isn't set up. The app still works, but this device won't share data with others. |

You do not need to press anything to make it sync. Just keep working.

**One thing to know:** a sale recorded offline is on *that device* until it
gets a connection. If the counter tablet is offline, the owner's phone
won't see this morning's sales until the tablet reconnects. Nothing is
lost — it just arrives late.

---

## Using more than one device

Every device — counter tablet, owner's phone, back-office computer — shows
the same products, sales and debts, usually within half a minute of each
other.

Two people can record deliveries of the same product at the same time, even
both offline, and the stock count will end up correct once both reconnect.
The app adds up the movements rather than overwriting a number.

The one case to avoid: **two people editing the same product's name or
price at the same moment.** One of those edits will quietly win. It's rare,
and it only affects product details — never a sale, never a payment, never
a stock count.

---

## Installing it on a phone or tablet

A banner offers to install the app. Tap it and it gets a proper home-screen
icon and opens full screen with no browser bars. On iPhone, use Safari's
share button → **Add to Home Screen**.

Installing is worth doing: it starts faster and is more reliable offline.

---

## Things worth knowing

- **Nothing is ever really deleted.** Deleted products are hidden, not
  erased, so your sales history always stays complete.
- **Every sale records which device recorded it.** There are no individual
  staff logins, so the device is as far as the trail goes.
- **No receipt printing and no barcode scanning** in this version.
- **Prices with kobo are handled exactly.** ₦999.99 × 3 records as
  ₦2,999.97, not a fraction off.
- **Don't clear the browser's site data** on a device that still shows
  "Offline — will sync". That would throw away work that hasn't gone up
  yet. Wait for "Synced" first.
