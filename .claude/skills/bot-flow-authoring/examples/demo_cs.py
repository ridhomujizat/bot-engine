#!/usr/bin/env python3
"""Example: a small customer-service bot with 9 flows, built with flowkit.

  python3 demo_cs.py out      -> out/demo-cs (then validate.sh / pack.sh / import.sh)
"""
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "scripts"))
from flowkit import Bot, any_of, pick, set_var  # noqa: E402

MENU = "main.flow.json#menu"  # re-enters the menu node, so the menu is shown again
bot = Bot("demo-cs", name="Demo CS", timeout="10m", description="Demo customer service bot")

# main: greet with the customer's name from downstream worker metadata, then a menu that waits for a click
OPTIONS = ["Info Produk", "Cek Tagihan", "Promo", "Jam Operasional", "Bantuan", "Selesai"]
main = bot.flow("main")
main.node("entry", on_enter=[set_var("session", "nama", "{{event.payload.metadata.cust_name}}"),
                             bot.text("Halo {{session.nama}}! Selamat datang di Demo CS 👋")],
          next=[("true", "menu")])
main.node("menu", on_enter=[bot.choice("Ada yang bisa kami bantu?", OPTIONS)], wait=True, next=[
    (pick("Info Produk"), "produk.flow.json"), (pick("Cek Tagihan"), "tagihan.flow.json"),
    (pick("Promo"), "promo.flow.json"), (pick("Jam Operasional"), "jam-operasional.flow.json"),
    (pick("Bantuan"), "bantuan.flow.json"), (pick("Selesai"), "feedback.flow.json"), ("true", "tidak-paham")])
main.node("tidak-paham", on_enter=[bot.text("Maaf, pilih salah satu menu ya 🙏")], next=[("true", "menu")])

# produk: carousel + choice, store the picked package in session
produk = bot.flow("produk")
produk.node("entry", on_enter=[
    bot.carousel([dict(title=f"Paket {p}", subtitle=s, image=f"https://placehold.co/600x300/png?text={p}",
                       actions=[(f"Pilih {p}", p)]) for p, s in
                  [("Basic", "20 Mbps • Rp150.000/bln"), ("Pro", "50 Mbps • Rp300.000/bln"), ("Max", "100 Mbps • Rp500.000/bln")]]),
    bot.choice("Pilih paket atau kembali ke menu", ["Basic", "Pro", "Max", "Kembali"])],
    wait=True, next=[(any_of("Basic", "Pro", "Max"), "dipilih"), ("true", MENU)])
produk.node("dipilih", on_enter=[set_var("session", "paket", "{{event.preview}}"),
                                 bot.text("Siap! Paket {{session.paket}} sudah kami catat.")], next=[("true", MENU)])

# tagihan: free-text input validated by a custom action
bot.action("cek-nomor", """
const digits = String(event.preview || '').replace(/\\D/g, '')
temp.valid = digits.length === 10
temp.nomor = digits
const amount = (Number(digits.slice(-4)) % 900 + 100) * 1000
temp.jumlah = String(amount).replace(/\\B(?=(\\d{3})+(?!\\d))/g, '.')
""", title="Cek nomor pelanggan", description="Validasi nomor pelanggan dan hitung tagihan demo")
tagihan = bot.flow("tagihan")
tagihan.node("entry", on_enter=[bot.text("Masukkan nomor pelanggan Anda (10 digit):")], next=[("true", "input")])
tagihan.node("input", on_receive=["cek-nomor {}"], next=[("temp.valid === true", "hasil"), ("true", "salah")])
tagihan.node("salah", on_enter=[bot.text("Nomor tidak valid, harus 10 digit angka.")], next=[("true", "input")])
tagihan.node("hasil", on_enter=[bot.text("Tagihan nomor {{temp.nomor}} bulan ini: Rp {{temp.jumlah}}.")],
             next=[("true", MENU)])

bot.flow("promo").node("entry", on_enter=[
    bot.image("https://placehold.co/600x300/png?text=Promo", title="Promo Akhir Tahun"),
    bot.text("Diskon 50% 3 bulan pertama untuk pelanggan baru!")], next=[("true", MENU)])
bot.flow("jam-operasional").node("entry", on_enter=[bot.text("Buka Senin–Jumat 08.00–17.00.")], next=[("true", MENU)])

# bantuan: FAQ via a choice SKILL (keyword matching + retries), handover goes to its own flow
bantuan = bot.flow("bantuan")
faq = bot.choice("Pilih pertanyaan:", ["Cara bayar", "Lupa password", "Bicara dengan agen", "Kembali"])
bot.choice_skill(bantuan, "faq", question=faq, max_retries=2, fallback=MENU,
                 invalid=bot.text("Pilihan tidak tersedia, silakan klik salah satu tombol."), choices={
    "Cara bayar": "cara-bayar", "Lupa password": "lupa-password", "Bicara dengan agen": "agen.flow.json", "Kembali": MENU})
bantuan.nodes.insert(0, bantuan.nodes.pop())  # make the skill node the start node
bantuan.node("cara-bayar", on_enter=[bot.text("Bayar via transfer bank, e-wallet, atau minimarket.")], next=[("true", "faq")])
bantuan.node("lupa-password", on_enter=[bot.text('Klik "Lupa password" di halaman login.')], next=[("true", "faq")])

bot.flow("agen").node("entry", on_enter=[set_var("session", "handover", "true"),
                                         bot.text("Baik, kami sambungkan ke agen.")], next=[("true", "END")])

fb = bot.flow("feedback")
fb.node("entry", on_enter=[bot.choice("Bagaimana pelayanan kami?", ["😀 Puas", "😐 Biasa", "🙁 Kurang"])],
        wait=True, next=[("true", "terima-kasih")])
fb.node("terima-kasih", on_enter=[set_var("session", "rating", "{{event.preview}}"),
                                  bot.text("Terima kasih ({{session.rating}}). Sampai jumpa! 👋")], next=[("true", "END")])

if __name__ == "__main__":
    print(bot.write(sys.argv[1] if len(sys.argv) > 1 else "/tmp/flowkit-out"))
