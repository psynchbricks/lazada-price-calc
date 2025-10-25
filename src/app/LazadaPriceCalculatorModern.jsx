import React, { useState } from 'react';
import * as XLSX from 'xlsx';

const num = (v) => (v === '' || v === null || v === undefined ? 0 : Number(v));
const clamp0 = (x) => (x < 0 ? 0 : x);
const PREMIUM_CAP_INCL_VAT = 319.93; // Baht, VAT included

export default function LazadaPriceCalculatorModern() {
  // Panel 1: fees (VAT-inclusive)
  const [fees, setFees] = useState({ msf: 11.66, payment: 3.38, premium: 4.28, campaign: 5.35 });

  // Panel 2: product + profit target + seller discounts
  const [products, setProducts] = useState([]);
  const [currentProduct, setCurrentProduct] = useState({
    sku: '',
    cost: '',
    extraCost: '',
    // new seller discount fields
    sellerDiscValue: '', // coupon from seller
    sellerDiscType: '%', // '%' | 'บาท'
    mandDiscValue: '5', // mandatory campaign seller discount (default 5%)
    mandDiscType: '%',
    // profit target
    targetProfitValue: '',
    targetProfitType: '%', // '%' | 'บาท'
  });

  const [results, setResults] = useState([]);
  const [searchTerm, setSearchTerm] = useState('');

  // ===== File Upload (CSV/Excel) =====
  const handleFileUpload = (e) => {
    const file = e.target.files && e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (evt) => {
      const data = new Uint8Array(evt.target.result);
      const wb = XLSX.read(data, { type: 'array' });
      const sheet = wb.Sheets[wb.SheetNames[0]];
      const rows = XLSX.utils.sheet_to_json(sheet);
      const mapped = rows.map((r) => ({
        sku: r.SKU || '',
        cost: r.Cost ?? 0,
        extraCost: r.ExtraCost ?? 0,
        sellerDiscValue: r.SellerDisc ?? 0,
        sellerDiscType: (r.SellerDiscType === 'บาท' || r.SellerDiscType === 'THB') ? 'บาท' : '%',
        mandDiscValue: r.MandDisc ?? 5,
        mandDiscType: (r.MandDiscType === 'บาท' || r.MandDiscType === 'THB') ? 'บาท' : '%',
        targetProfitValue: r.TargetProfit ?? 0,
        targetProfitType: (r.TargetType === 'บาท' || r.TargetType === 'THB') ? 'บาท' : '%',
      }));
      setProducts(mapped);
    };
    reader.readAsArrayBuffer(file);
  };

  // ===== Core solver with seller discounts =====
  function solvePrice({ C, rPct, gBaht, msfPct, payPct, premPct, campPct, dPct, dBaht }) {
    // dPct = combined seller discount percent (0..1) of price, dBaht = combined fixed discount in baht
    const f = (msfPct + payPct + campPct) / 100; // variable fee fraction (incl VAT)
    const p = premPct / 100; // premium fraction (incl VAT)
    const eps = 1e-9;

    // Effective price used for fee bases: P_eff = (1 - dPct) * P - dBaht
    // --- Non-cap: premium = p * P_eff
    // Target as % of price (r):  C + (f + p) * P_eff + rP = P
    // => [1 - r - (f+p)(1 - dPct)] P = C - (f+p) * dBaht
    // Target as ฿ (g):            C + g + (f + p) * P_eff = P
    // => [1 - (f+p)(1 - dPct)] P = C + g - (f+p) * dBaht

    // --- Cap: premium = CAP
    // % target:  C + f * P_eff + CAP + rP = P
    // => [1 - r - f(1 - dPct)] P = C + CAP - f * dBaht
    // ฿ target:  C + g + f * P_eff + CAP = P
    // => [1 - f(1 - dPct)] P = C + g + CAP - f * dBaht

    let P_nonCap = null;
    let P_cap = null;

    if (rPct !== null && rPct !== undefined) {
      const r = rPct / 100;
      const denomNon = 1 - r - (f + p) * (1 - dPct);
      if (Math.abs(denomNon) > eps) P_nonCap = (C - (f + p) * dBaht) / denomNon;
      const denomCap = 1 - r - f * (1 - dPct);
      if (Math.abs(denomCap) > eps) P_cap = (C + PREMIUM_CAP_INCL_VAT - f * dBaht) / denomCap;
    }

    if (gBaht !== null && gBaht !== undefined) {
      const denomNon = 1 - (f + p) * (1 - dPct);
      if (Math.abs(denomNon) > eps) P_nonCap = (C + gBaht - (f + p) * dBaht) / denomNon;
      const denomCap = 1 - f * (1 - dPct);
      if (Math.abs(denomCap) > eps) P_cap = (C + gBaht + PREMIUM_CAP_INCL_VAT - f * dBaht) / denomCap;
    }

    // Check feasibility of non-cap using P_eff
    const P_eff_non = P_nonCap ? (1 - dPct) * P_nonCap - dBaht : null;
    const nonCapOK = P_eff_non && P_eff_non > 0 && (p * P_eff_non) < (PREMIUM_CAP_INCL_VAT - 1e-6);

    const P = nonCapOK ? P_nonCap : P_cap;
    const P_eff = clamp0((1 - dPct) * P - dBaht);

    // Fee breakdown on effective base
    const msfFee = P_eff * (msfPct / 100);
    const payFee = P_eff * (payPct / 100);
    const campFee = P_eff * (campPct / 100);
    const premFee = Math.min(P_eff * p, PREMIUM_CAP_INCL_VAT);

    const totalFee = msfFee + payFee + campFee + premFee;
    const net = P - totalFee;
    const profit = net - C;

    return { P, P_eff, msfFee, payFee, premFee, campFee, totalFee, net, profit };
  }

  const calculate = () => {
    const list = products.length ? products : [currentProduct];

    const out = list.map((p) => {
      const sku = p.sku || '';
      const C = num(p.cost) + num(p.extraCost);

      const msfPct = num(fees.msf);
      const payPct = num(fees.payment);
      const premPct = num(fees.premium);
      const campPct = num(fees.campaign);

      // Build discount mix from Panel 2
      const sellerVal = num(p.sellerDiscValue);
      const sellerIsPct = (p.sellerDiscType || '%') === '%';
      const mandVal = num(p.mandDiscValue);
      const mandIsPct = (p.mandDiscType || '%') === '%';

      // We don't know P yet; solver expects aggregated dPct and dBaht relative to P.
      // If a discount is %, it contributes to dPct (e.g., 5% => 0.05). If baht, it contributes to dBaht.
      const dPct = (sellerIsPct ? sellerVal / 100 : 0) + (mandIsPct ? mandVal / 100 : 0);
      const dBaht = (sellerIsPct ? 0 : sellerVal) + (mandIsPct ? 0 : mandVal);

      // Profit target
      const targetValue = num(p.targetProfitValue);
      const isPct = (p.targetProfitType || '%') === '%';

      const solved = solvePrice({
        C,
        rPct: isPct ? targetValue : null,
        gBaht: isPct ? null : targetValue,
        msfPct, payPct, premPct, campPct,
        dPct, dBaht,
      });

      // Compute realized discounts at solved P
      const sellerDiscBaht = sellerIsPct ? (solved.P * (sellerVal / 100)) : sellerVal;
      const mandDiscBaht = mandIsPct ? (solved.P * (mandVal / 100)) : mandVal;

      return {
        SKU: sku,
        Cost: C.toFixed(2),
        Price: solved.P?.toFixed(2) || '-',
        Price_Effective_for_Fees: solved.P_eff?.toFixed(2) || '-',
        Seller_Discount: sellerDiscBaht.toFixed(2),
        Mandatory_Discount: mandDiscBaht.toFixed(2),
        MSF_Fee: solved.msfFee?.toFixed(2) || '-',
        Payment_Fee: solved.payFee?.toFixed(2) || '-',
        Premium_Fee: solved.premFee?.toFixed(2) || '-',
        Campaign_Fee: solved.campFee?.toFixed(2) || '-',
        Total_Fees: solved.totalFee?.toFixed(2) || '-',
        Net_After_Fees: solved.net?.toFixed(2) || '-',
        Profit: solved.profit?.toFixed(2) || '-',
        ProfitPctOfPrice: solved.P ? ((solved.profit / solved.P) * 100).toFixed(2) : '-',
        Target: isPct ? `${targetValue}%` : `${targetValue} บาท`,
      };
    });

    setResults(out);
  };

  const exportExcel = () => {
    if (!results.length) return;
    const ws = XLSX.utils.json_to_sheet(results);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Results');
    XLSX.writeFile(wb, 'Lazada_Price_Calc_FeeBreakdown.xlsx');
  };

  const filtered = results.filter((r) => (r.SKU || '').toLowerCase().includes(searchTerm.toLowerCase()));

  return (
    <div style={{ fontFamily: 'Inter, sans-serif', color: '#333', background: '#fafafa', minHeight: '100vh', padding: '2rem 4rem' }}>
      <h1 style={{ fontSize: 28, fontWeight: 700, textAlign: 'center', marginBottom: 40 }}>🧮 Lazada Price Calculator</h1>

      <div style={{ display: 'grid', gap: 32, maxWidth: 1200, margin: '0 auto' }}>
        {/* Panel 1 */}
        <section style={{ background: '#fff', borderRadius: 12, boxShadow: '0 2px 8px rgba(0,0,0,0.05)', padding: 24 }}>
          <h2 style={{ fontSize: 20, fontWeight: 600, borderBottom: '1px solid #eee', paddingBottom: 8 }}>📊 Platform Fees</h2>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))', gap: 16, marginTop: 16 }}>
            {['msf','payment','premium','campaign'].map((key) => (
              <div key={key} style={{ display: 'flex', flexDirection: 'column' }}>
                <label style={{ fontSize: 14, fontWeight: 500, marginBottom: 4 }}>
                  {key === 'msf' ? 'Commission Fee (MSF) – % (รวม VAT)' : key === 'payment' ? 'Payment Fee – % (รวม VAT)' : key === 'premium' ? 'Premium Fee – % (รวม VAT, Max 319.93)' : 'Campaign Voucher Fee – % (รวม VAT)'}
                </label>
                <input type="number" value={fees[key]} step="0.01" onChange={(e) => setFees({ ...fees, [key]: e.target.value })} style={{ padding: '8px 10px', borderRadius: 8, border: '1px solid #ccc' }} />
              </div>
            ))}
          </div>
        </section>

        {/* Panel 2 */}
        <section style={{ background: '#fff', borderRadius: 12, boxShadow: '0 2px 8px rgba(0,0,0,0.05)', padding: 24 }}>
          <h2 style={{ fontSize: 20, fontWeight: 600, borderBottom: '1px solid #eee', paddingBottom: 8 }}>📦 Product, Discounts & Profit Target</h2>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: 20, marginTop: 16 }}>
            <div style={{ display: 'flex', flexDirection: 'column' }}>
              <label style={{ fontSize: 14, fontWeight: 500, marginBottom: 4 }}>ชื่อ SKU</label>
              <input placeholder="เช่น LEGO 10283" value={currentProduct.sku} onChange={(e) => setCurrentProduct({ ...currentProduct, sku: e.target.value })} style={{ padding: '8px 10px', borderRadius: 8, border: '1px solid #ccc' }} />
            </div>

            <div style={{ display: 'flex', flexDirection: 'column' }}>
              <label style={{ fontSize: 14, fontWeight: 500, marginBottom: 4 }}>ต้นทุนสินค้า (บาท)</label>
              <input type="number" step="0.01" value={currentProduct.cost} onChange={(e) => setCurrentProduct({ ...currentProduct, cost: e.target.value })} style={{ padding: '8px 10px', borderRadius: 8, border: '1px solid #ccc' }} />
            </div>

            <div style={{ display: 'flex', flexDirection: 'column' }}>
              <label style={{ fontSize: 14, fontWeight: 500, marginBottom: 4 }}>ต้นทุนอื่นๆ (บาท)</label>
              <input type="number" step="0.01" value={currentProduct.extraCost} onChange={(e) => setCurrentProduct({ ...currentProduct, extraCost: e.target.value })} style={{ padding: '8px 10px', borderRadius: 8, border: '1px solid #ccc' }} />
            </div>

            {/* Seller coupon discount */}
            <div style={{ display: 'flex', flexDirection: 'column' }}>
              <label style={{ fontSize: 14, fontWeight: 600, marginBottom: 4 }}>ส่วนลดคูปองร้านค้า</label>
              <div style={{ display: 'flex', gap: 8 }}>
                <input type="number" step="0.01" value={currentProduct.sellerDiscValue} onChange={(e) => setCurrentProduct({ ...currentProduct, sellerDiscValue: e.target.value })} placeholder="เช่น 5 หรือ 100" style={{ flex: 1, padding: '8px 10px', borderRadius: 8, border: '1px solid #ccc' }} />
                <select value={currentProduct.sellerDiscType} onChange={(e) => setCurrentProduct({ ...currentProduct, sellerDiscType: e.target.value })} style={{ borderRadius: 8, border: '1px solid #ccc', padding: '8px 10px' }}>
                  <option value="%">% ของราคาขาย</option>
                  <option value="บาท">บาท</option>
                </select>
              </div>
            </div>

            {/* Mandatory campaign seller discount */}
            <div style={{ display: 'flex', flexDirection: 'column' }}>
              <label style={{ fontSize: 14, fontWeight: 600, marginBottom: 4 }}>ส่วนลดร้านค้าจากข้อบังคับแคมเปญ</label>
              <div style={{ display: 'flex', gap: 8 }}>
                <input type="number" step="0.01" value={currentProduct.mandDiscValue} onChange={(e) => setCurrentProduct({ ...currentProduct, mandDiscValue: e.target.value })} placeholder="ค่าเริ่มต้น 5" style={{ flex: 1, padding: '8px 10px', borderRadius: 8, border: '1px solid #ccc' }} />
                <select value={currentProduct.mandDiscType} onChange={(e) => setCurrentProduct({ ...currentProduct, mandDiscType: e.target.value })} style={{ borderRadius: 8, border: '1px solid #ccc', padding: '8px 10px' }}>
                  <option value="%">% ของราคาขาย</option>
                  <option value="บาท">บาท</option>
                </select>
              </div>
              <small style={{ color: '#6b7280', marginTop: 4 }}>ส่วนลดนี้จะหักออกจากราคาขายก่อนคำนวณ Platform Fees ทั้งหมด</small>
            </div>

            {/* Profit target */}
            <div style={{ display: 'flex', flexDirection: 'column' }}>
              <label style={{ fontSize: 14, fontWeight: 600, marginBottom: 4 }}>กำไรที่ต้องการ</label>
              <div style={{ display: 'flex', gap: 8 }}>
                <input type="number" step="0.01" value={currentProduct.targetProfitValue} onChange={(e) => setCurrentProduct({ ...currentProduct, targetProfitValue: e.target.value })} style={{ flex: 1, padding: '8px 10px', borderRadius: 8, border: '1px solid #ccc' }} />
                <select value={currentProduct.targetProfitType} onChange={(e) => setCurrentProduct({ ...currentProduct, targetProfitType: e.target.value })} style={{ borderRadius: 8, border: '1px solid #ccc', padding: '8px 10px' }}>
                  <option value="%">% จากราคาขาย</option>
                  <option value="บาท">บาท</option>
                </select>
              </div>
            </div>

            <div style={{ display: 'flex', flexDirection: 'column' }}>
              <label style={{ fontSize: 14, fontWeight: 500, marginBottom: 4 }}>อัปโหลดไฟล์ CSV/Excel</label>
              <input type="file" accept=".csv,.xlsx,.xls" onChange={handleFileUpload} style={{ border: '1px solid #ccc', borderRadius: 8, padding: '8px 10px' }} />
            </div>
          </div>
        </section>

        {/* Panel 3 */}
        <section style={{ background: '#fff', borderRadius: 12, boxShadow: '0 2px 8px rgba(0,0,0,0.05)', padding: 24 }}>
          <h2 style={{ fontSize: 20, fontWeight: 600, borderBottom: '1px solid #eee', paddingBottom: 8 }}>📈 ผลลัพธ์การคำนวณ</h2>
          <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 12 }}>
            <button onClick={() => calculate()} style={{ background: '#2563eb', color: '#fff', padding: '10px 18px', borderRadius: 8, border: 'none', cursor: 'pointer' }}>คำนวณราคาขาย</button>
            <input placeholder="🔍 ค้นหา SKU..." value={searchTerm} onChange={(e) => setSearchTerm(e.target.value)} style={{ padding: '8px 12px', borderRadius: 8, border: '1px solid #ccc', width: 220 }} />
            <button onClick={exportExcel} style={{ background: '#10b981', color: '#fff', padding: '10px 18px', borderRadius: 8, border: 'none', cursor: 'pointer' }}>Export Excel</button>
          </div>

          {filtered.length > 0 && (
            <div style={{ overflowX: 'auto', marginTop: 20 }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 14 }}>
                <thead style={{ background: '#f3f4f6' }}>
                  <tr>
                    {['SKU','ต้นทุนรวม','ราคาขาย','ราคาฐานคำนวณค่าธรรมเนียม (P_eff)','คูปองร้านค้า','ส่วนลดบังคับแคมเปญ','MSF','Payment','Premium','Campaign','รวมค่าธรรมเนียม','รายได้หลังหัก','กำไรสุทธิ','กำไร (%)','เป้ากำไร'].map((h) => (
                      <th key={h} style={{ borderBottom: '2px solid #e5e7eb', padding: '10px 8px', textAlign: 'center' }}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {filtered.map((r, i) => (
                    <tr key={i} style={{ borderBottom: '1px solid #eee', background: i % 2 ? '#fafafa' : 'white' }}>
                      <td style={{ textAlign: 'center', padding: '8px 6px' }}>{r.SKU}</td>
                      <td style={{ textAlign: 'right', padding: '8px 6px' }}>{r.Cost}</td>
                      <td style={{ textAlign: 'right', padding: '8px 6px' }}>{r.Price}</td>
                      <td style={{ textAlign: 'right', padding: '8px 6px' }}>{r.Price_Effective_for_Fees}</td>
                      <td style={{ textAlign: 'right', padding: '8px 6px' }}>{r.Seller_Discount}</td>
                      <td style={{ textAlign: 'right', padding: '8px 6px' }}>{r.Mandatory_Discount}</td>
                      <td style={{ textAlign: 'right', padding: '8px 6px' }}>{r.MSF_Fee}</td>
                      <td style={{ textAlign: 'right', padding: '8px 6px' }}>{r.Payment_Fee}</td>
                      <td style={{ textAlign: 'right', padding: '8px 6px' }}>{r.Premium_Fee}</td>
                      <td style={{ textAlign: 'right', padding: '8px 6px' }}>{r.Campaign_Fee}</td>
                      <td style={{ textAlign: 'right', padding: '8px 6px' }}>{r.Total_Fees}</td>
                      <td style={{ textAlign: 'right', padding: '8px 6px' }}>{r.Net_After_Fees}</td>
                      <td style={{ textAlign: 'right', padding: '8px 6px' }}>{r.Profit}</td>
                      <td style={{ textAlign: 'right', padding: '8px 6px' }}>{r.ProfitPctOfPrice}</td>
                      <td style={{ textAlign: 'center', padding: '8px 6px' }}>{r.Target}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
