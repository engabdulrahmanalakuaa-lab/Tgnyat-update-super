const { ipcRenderer } = require('electron');

// ========== المتغيرات العامة ==========
let currentUser = null;
let currentCompany = null;
let currentShift = null;
let cart = [];
let totalSalesCash = 0;
let currentCategory = 'all';
let selectedPayment = 'cash';
let currentShiftId = null;
let taxRate = 0;
let userDataPath = null;

// ========== تسجيل الدخول ==========
async function submitLogin() {
    const username = document.getElementById('login-username').value.trim();
    const password = document.getElementById('login-password').value.trim();
    if (!username || !password) return alert('أدخل اسم المستخدم وكلمة المرور');

    const result = await ipcRenderer.invoke('login', { username, password });
    if (!result.success) {
        alert(result.error || 'بيانات الدخول خاطئة');
        return;
    }
    currentUser = result.user;
    document.getElementById('current-user-display').innerText = currentUser.full_name;
    document.getElementById('user-role-badge').innerText = currentUser.role;

    document.getElementById('login-screen').style.display = 'none';
    document.getElementById('app-main').style.display = 'flex';

    await loadCompanyData();
    const settings = await ipcRenderer.invoke('get-settings', currentCompany.id);
    window.appSettings = settings || {};

    await initUserDataPath(); // الحصول على مسار userData
    await openShiftIfNeeded();

    const company = await ipcRenderer.invoke('get-company');
    taxRate = company ? company.tax_rate || 0 : 0;

    if (!currentCompany.name || currentCompany.name === 'مطعم تقنيات سوفت' || taxRate === 0) {
        openCompanyModal();
    } else {
        switchTab('dashboard');
    }
}

// ========== تحميل مسار بيانات المستخدم ==========
async function initUserDataPath() {
    userDataPath = await ipcRenderer.invoke('get-user-data-path');
}

// ========== تحميل بيانات الشركة ==========
async function loadCompanyData() {
    const company = await ipcRenderer.invoke('get-company');
    if (company) {
        currentCompany = company;
        taxRate = company.tax_rate || 0;
    } else {
        const result = await ipcRenderer.invoke('db-run',
            "INSERT INTO companies (name, phone, address, tax_rate) VALUES (?, ?, ?, ?)",
            ['مطعم تقنيات سوفت', '773579486', 'اليمن - صنعاء', 0]);
        if (result.lastInsertRowid) {
            currentCompany = { id: result.lastInsertRowid, name: 'مطعم تقنيات سوفت', phone: '773579486', address: 'اليمن - صنعاء', tax_rate: 0 };
            taxRate = 0;
        }
    }
    if (currentCompany) document.title = `تقنيات سوفت - ${currentCompany.name}`;
}

// ========== نافذة بيانات الشركة ==========
function openCompanyModal() {
    document.getElementById('company-name').value = currentCompany ? currentCompany.name : '';
    document.getElementById('company-phone').value = currentCompany ? currentCompany.phone : '';
    document.getElementById('company-address').value = currentCompany ? currentCompany.address : '';
    document.getElementById('company-tax').value = currentCompany ? currentCompany.tax_number || '' : '';
    document.getElementById('company-tax-rate').value = currentCompany ? currentCompany.tax_rate || 0 : 0;
    document.getElementById('company-modal').style.display = 'flex';
}

async function saveCompanyFromModal() {
    const name = document.getElementById('company-name').value.trim();
    const phone = document.getElementById('company-phone').value.trim();
    const address = document.getElementById('company-address').value.trim();
    const tax_number = document.getElementById('company-tax').value.trim();
    const tax_rate = parseFloat(document.getElementById('company-tax-rate').value) || 0;
    if (!name) { alert('اسم المطعم مطلوب'); return; }
    await ipcRenderer.invoke('update-company', { name, phone, address, tax_number, tax_rate, userId: currentUser.id });
    currentCompany.name = name;
    currentCompany.phone = phone;
    currentCompany.address = address;
    currentCompany.tax_number = tax_number;
    currentCompany.tax_rate = tax_rate;
    taxRate = tax_rate;
    document.title = `تقنيات سوفت - ${name}`;
    document.getElementById('company-modal').style.display = 'none';
    alert(`تم حفظ بيانات المطعم ونسبة الضريبة: ${tax_rate}%`);
    switchTab('dashboard');
}

// ========== فتح الوردية ==========
async function openShiftIfNeeded() {
    const today = new Date().toISOString().slice(0,10);
    const shift = await ipcRenderer.invoke('db-get',
        "SELECT * FROM shifts WHERE company_id=? AND date=? AND status='open' AND user_id=?",
        [currentCompany.id, today, currentUser.id]
    );
    if (shift) {
        currentShift = shift;
        currentShiftId = shift.id;
        const total = await ipcRenderer.invoke('db-get',
            "SELECT COALESCE(SUM(total),0) as total FROM orders WHERE company_id=? AND date=? AND shift_id=?",
            [currentCompany.id, today, currentShift.id]
        );
        totalSalesCash = total ? total.total : 0;
    } else {
        const opening = prompt('أدخل رصيد افتتاح الصندوق (ر.س):', '0');
        const openingCash = parseFloat(opening) || 0;
        const result = await ipcRenderer.invoke('open-shift', {
            company_id: currentCompany.id,
            user_id: currentUser.id,
            opening_cash: openingCash
        });
        if (result.success) {
            currentShiftId = result.shiftId;
            const newShift = await ipcRenderer.invoke('db-get', "SELECT * FROM shifts WHERE id=?", [result.shiftId]);
            currentShift = newShift;
        }
        totalSalesCash = 0;
    }
}

// ========== تبديل التبويبات ==========
async function switchTab(tab) {
    const perms = currentUser.permissions || {};
    const restrictedTabs = {
        'users': perms.can_edit_users,
        'reports': perms.can_view_reports,
        'expenses': perms.can_view_reports,
        'audit': perms.can_view_reports
    };
    if (restrictedTabs[tab] !== undefined && !restrictedTabs[tab]) {
        alert('ليس لديك صلاحية للوصول إلى هذه الصفحة');
        return;
    }

    document.querySelectorAll('.nav-btn').forEach(b => b.classList.remove('active'));
    document.querySelector(`.nav-btn[data-tab="${tab}"]`).classList.add('active');
    const main = document.getElementById('main-content');
    main.innerHTML = '';
    switch (tab) {
        case 'dashboard': await renderDashboard(); break;
        case 'pos': await renderPOS(); break;
        case 'products': await renderProducts(); break;
        case 'categories': await renderCategories(); break;
        case 'materials': await renderMaterials(); break;
        case 'tables': await renderTables(); break;
        case 'waiters': await renderWaiters(); break;
        case 'reports': await renderReports(); break;
        case 'expenses': await renderExpenses(); break;
        case 'audit': await renderAudit(); break;
        case 'users': await renderUsers(); break;
        case 'settings': await renderSettings(); break;
    }
}

// ========== لوحة التحكم ==========
async function renderDashboard() {
    const today = new Date().toISOString().slice(0,10);
    const orders = await ipcRenderer.invoke('db-query',
        "SELECT * FROM orders WHERE company_id=? AND date=?", [currentCompany.id, today]
    );
    const totalSales = orders.reduce((s,o) => s + o.total, 0);
    const totalTax = orders.reduce((s,o) => s + (o.tax || 0), 0);
    const totalWithTax = orders.reduce((s,o) => s + (o.total_with_tax || o.total), 0);
    const lowStock = await ipcRenderer.invoke('db-query',
        "SELECT * FROM raw_materials WHERE company_id=? AND current_stock <= min_stock", [currentCompany.id]
    );
    const occupiedTables = await ipcRenderer.invoke('db-query',
        "SELECT COUNT(*) as cnt FROM tables WHERE company_id=? AND status='occupied'", [currentCompany.id]
    );
    document.getElementById('main-content').innerHTML = `
        <div class="page-header"><h1>لوحة التحكم - ${currentCompany.name}</h1>
            <span class="badge">${currentUser.role === 'admin' ? 'مدير' : currentUser.role === 'accountant' ? 'محاسب' : 'كاشير'}</span>
        </div>
        <div class="stats-grid">
            <div class="stat-card"><div class="stat-icon"><i class="fas fa-money-bill"></i></div><div class="stat-info"><h3>مبيعات اليوم</h3><p>${totalSales.toFixed(2)} ر.س</p></div></div>
            <div class="stat-card"><div class="stat-icon"><i class="fas fa-percent"></i></div><div class="stat-info"><h3>الضريبة</h3><p>${totalTax.toFixed(2)} ر.س</p></div></div>
            <div class="stat-card"><div class="stat-icon"><i class="fas fa-receipt"></i></div><div class="stat-info"><h3>الإجمالي مع الضريبة</h3><p>${totalWithTax.toFixed(2)} ر.س</p></div></div>
            <div class="stat-card"><div class="stat-icon"><i class="fas fa-shopping-cart"></i></div><div class="stat-info"><h3>عدد الطلبات</h3><p>${orders.length}</p></div></div>
            <div class="stat-card"><div class="stat-icon"><i class="fas fa-chair"></i></div><div class="stat-info"><h3>طاولات مشغولة</h3><p>${occupiedTables.length > 0 ? occupiedTables[0].cnt : 0}</p></div></div>
            <div class="stat-card"><div class="stat-icon"><i class="fas fa-exclamation-triangle"></i></div><div class="stat-info"><h3>مواد حرجة</h3><p>${lowStock.length}</p></div></div>
        </div>
        <h3>آخر الطلبات</h3>
        <table><thead><tr><th>رقم</th><th>المبلغ</th><th>الضريبة</th><th>الإجمالي</th><th>طريقة الدفع</th><th>التاريخ</th></tr></thead><tbody>
        ${orders.slice(-5).map(o => `<tr><td>${o.id}</td><td>${o.total.toFixed(2)}</td><td>${(o.tax || 0).toFixed(2)}</td><td>${(o.total_with_tax || o.total).toFixed(2)}</td><td>${o.payment_method}</td><td>${o.time}</td></tr>`).join('')}
        </tbody></table>
    `;
}

// ========== نقطة البيع ==========
async function renderPOS() {
    const perms = currentUser.permissions || {};
    const categories = await ipcRenderer.invoke('db-query', "SELECT * FROM categories WHERE company_id=?", [currentCompany.id]);
    const tables = await ipcRenderer.invoke('db-query', "SELECT * FROM tables WHERE company_id=? AND status='free'", [currentCompany.id]);
    const waiters = await ipcRenderer.invoke('db-query', "SELECT * FROM waiters WHERE company_id=?", [currentCompany.id]);

    const iconMap = { 'أكلات شعبية': '🍗', 'غداء': '🍚', 'المعصوب': '🍰', 'مشروبات': '🥤' };
    const catBtns = categories.map(c => {
        const icon = iconMap[c.name] || '📦';
        return `<button class="cat-btn" onclick="filterPOS('${c.id}')">${icon} ${c.name}</button>`;
    }).join('');
    const tableOpts = tables.map(t => `<option value="${t.id}">${t.name}</option>`).join('');
    const waiterOpts = waiters.map(w => `<option value="${w.id}">${w.name}</option>`).join('');

    document.getElementById('main-content').innerHTML = `
        <div class="page-header"><h1>نقطة البيع (الضريبة: ${taxRate}%)</h1>
            <div>
                ${perms.can_refund ? `<button class="btn btn-warning" onclick="openRefundModal()"><i class="fas fa-undo"></i> إرجاع طلب</button>` : ''}
                <button class="btn btn-danger" onclick="closeShift()"><i class="fas fa-lock"></i> إغلاق الوردية</button>
            </div>
        </div>
        <div class="pos-container">
            <div class="menu-section">
                <div class="category-grid">
                    <button class="cat-btn active" onclick="filterPOS('all')">📋 الكل</button>
                    ${catBtns}
                </div>
                <input type="text" id="pos-search" placeholder="بحث..." oninput="searchPOS()" style="margin-bottom:10px; padding:8px; width:100%;">
                <div class="items-grid" id="pos-items-grid"></div>
            </div>
            <div class="invoice-section">
                <div class="shift-info-box">
                    <span>الوردية: <span id="shift-total">${totalSalesCash.toFixed(2)}</span> ر.س</span>
                    <span>#${currentShiftId || ''}</span>
                </div>
                <select id="pos-table" style="width:100%; padding:8px; margin-bottom:5px;"><option value="">بدون طاولة</option>${tableOpts}</select>
                <select id="pos-order-type" style="width:100%; padding:8px; margin-bottom:5px; font-weight:700; border:2px solid #e67e22; border-radius:6px;">
                    <option value="سفري" selected>🛵 سفري</option>
                    <option value="محلي">🍽️ محلي</option>
                </select>
                <select id="pos-waiter" style="width:100%; padding:8px; margin-bottom:5px;"><option value="">بدون كابتن</option>${waiterOpts}</select>
                <div class="cart-items" id="cart-items"></div>
                <div class="cart-total">
                    <div>المجموع: <span id="cart-subtotal">0.00</span> ر.س</div>
                    <div>الضريبة (${taxRate}%): <span id="cart-tax">0.00</span> ر.س</div>
                    <div style="font-weight:800; font-size:22px;">الإجمالي: <span id="cart-total">0.00</span> ر.س</div>
                </div>
                <div class="payment-options">
                    <button class="active" onclick="selectPayment('cash')">💰 نقدي</button>
                    <button onclick="selectPayment('card')">💳 بطاقة</button>
                    <button onclick="selectPayment('bank')">🏦 تحويل</button>
                </div>
                <button class="btn btn-success" style="width:100%; margin-bottom:5px;" onclick="checkoutPOS()">إنهاء الطلب</button>
                <button class="btn btn-danger" style="width:100%;" onclick="clearCart()">مسح السلة</button>
            </div>
        </div>
    `;
    await filterPOS('all');
    updateCartUI();
}

function selectPayment(method) {
    selectedPayment = method;
    document.querySelectorAll('.payment-options button').forEach(b => b.classList.remove('active'));
    document.querySelector(`.payment-options button[onclick="selectPayment('${method}')"]`).classList.add('active');
}

// ========== دوال POS ==========
async function filterPOS(catId) {
    currentCategory = catId;
    let products;
    if (catId === 'all') {
        products = await ipcRenderer.invoke('db-query', "SELECT * FROM products WHERE company_id=?", [currentCompany.id]);
    } else {
        products = await ipcRenderer.invoke('db-query', "SELECT * FROM products WHERE company_id=? AND category_id=?", [currentCompany.id, catId]);
    }
    await renderPOSItems(products);
}

async function searchPOS() {
    const q = document.getElementById('pos-search').value;
    const products = await ipcRenderer.invoke('db-query',
        "SELECT * FROM products WHERE company_id=? AND name LIKE ?", [currentCompany.id, `%${q}%`]
    );
    await renderPOSItems(products);
}

async function renderPOSItems(products) {
    const grid = document.getElementById('pos-items-grid');
    if (!grid) return;
    // تأكد من توفر userDataPath
    if (!userDataPath) {
        userDataPath = await ipcRenderer.invoke('get-user-data-path');
    }
    grid.innerHTML = products.map(p => `
        <div class="item-card" onclick="addToCartPOS(${p.id})">
            ${p.image ? `<img src="file://${userDataPath}/${p.image}" style="width:100%; height:80px; object-fit:cover; border-radius:4px;" onerror="this.style.display='none'">` :
            `<div style="width:100%; height:80px; background:#f0f0f0; display:flex; align-items:center; justify-content:center; border-radius:4px; font-size:24px;">🍽️</div>`}
            <div class="item-name">${p.name}</div>
            <div class="item-price">${p.price.toFixed(2)} ر.س</div>
        </div>
    `).join('');
}

async function addToCartPOS(productId) {
    const product = await ipcRenderer.invoke('db-get', "SELECT * FROM products WHERE id=?", [productId]);
    if (!product) return;
    const existing = cart.find(i => i.id === productId);
    if (existing) existing.qty += 1;
    else cart.push({ ...product, qty: 1 });
    updateCartUI();
}

function updateCartUI() {
    const container = document.getElementById('cart-items');
    const subtotalEl = document.getElementById('cart-subtotal');
    const taxEl = document.getElementById('cart-tax');
    const totalEl = document.getElementById('cart-total');
    if (!container) return;
    let subtotal = 0;
    container.innerHTML = cart.map((item, idx) => {
        subtotal += item.price * item.qty;
        return `<div class="cart-item">
            <span>${item.name} x${item.qty}</span>
            <span>${(item.price * item.qty).toFixed(2)}</span>
            <button class="btn btn-danger btn-sm" onclick="removeFromCart(${idx})">×</button>
        </div>`;
    }).join('');
    const tax = subtotal * (taxRate / 100);
    const total = subtotal + tax;
    subtotalEl.innerText = subtotal.toFixed(2);
    taxEl.innerText = tax.toFixed(2);
    totalEl.innerText = total.toFixed(2);
}

function removeFromCart(index) { cart.splice(index, 1); updateCartUI(); }
function clearCart() { cart = []; updateCartUI(); }

// ========== دالة إدخال آمنة للمبلغ المدفوع (بديل عن prompt المعطل في Electron) ==========
function askPaidAmount(subtotal, tax, total) {
    return new Promise((resolve) => {
        const modalContent = document.getElementById('modal-content');
        modalContent.innerHTML = `
            <h3 style="margin-bottom:15px;">الدفع نقداً</h3>
            <p>المجموع: <strong>${subtotal.toFixed(2)} ر.س</strong></p>
            <p>الضريبة: <strong>${tax.toFixed(2)} ر.س</strong></p>
            <p style="font-size:18px; margin:10px 0;">الإجمالي: <strong>${total.toFixed(2)} ر.س</strong></p>
            <div class="form-group">
                <label>المبلغ المدفوع</label>
                <input type="number" id="paid-amount-input" step="0.01" value="${total.toFixed(2)}" style="font-size:18px;">
            </div>
            <button class="btn btn-success" id="paid-confirm-btn" style="width:100%; margin-bottom:5px;">تأكيد الدفع</button>
            <button class="btn btn-secondary" id="paid-cancel-btn" style="width:100%;">إلغاء</button>
        `;
        document.getElementById('modal').classList.add('active');
        const input = document.getElementById('paid-amount-input');
        input.focus();
        input.select();

        const cleanup = () => { document.getElementById('modal').classList.remove('active'); };
        const confirmPay = () => {
            const val = parseFloat(input.value);
            cleanup();
            resolve(isNaN(val) ? total : val);
        };
        document.getElementById('paid-confirm-btn').onclick = confirmPay;
        document.getElementById('paid-cancel-btn').onclick = () => { cleanup(); resolve(null); };
        input.onkeydown = (e) => { if (e.key === 'Enter') confirmPay(); };
    });
}

// ========== إنهاء الطلب ==========
async function checkoutPOS() {
    if (cart.length === 0) return alert('السلة فارغة');
    const tableId = document.getElementById('pos-table').value || null;
    const waiterId = document.getElementById('pos-waiter').value || null;
    const orderTypeEl = document.getElementById('pos-order-type');
    const orderType = orderTypeEl ? orderTypeEl.value : 'سفري';
    const subtotal = cart.reduce((s, i) => s + (i.price * i.qty), 0);
    const tax = subtotal * (taxRate / 100);
    const total = subtotal + tax;

    let paidAmount = total;
    if (selectedPayment === 'cash') {
        // استخدام نافذة إدخال آمنة بدلاً من prompt المعطل في Electron
        const paid = await askPaidAmount(subtotal, tax, total);
        if (paid === null) return; // ألغى المستخدم العملية
        paidAmount = paid;
    }

    const result = await ipcRenderer.invoke('create-order', {
        company_id: currentCompany.id,
        table_id: tableId,
        waiter_id: waiterId,
        user_id: currentUser.id,
        total: subtotal,
        tax: tax,
        total_with_tax: total,
        discount: 0,
        payment_method: selectedPayment,
        paid_amount: paidAmount,
        shift_id: currentShiftId,
        items: cart.map(i => ({ id: i.id, qty: i.qty, price: i.price, recipe: i.recipe }))
    });

    if (!result.success) {
        alert('فشل حفظ الطلب: ' + (result.error || ''));
        return;
    }

    if (tableId) {
        await ipcRenderer.invoke('db-run', "UPDATE tables SET status='occupied' WHERE id=?", [tableId]);
    }

    totalSalesCash += subtotal;
    document.getElementById('shift-total').innerText = totalSalesCash.toFixed(2);
    await printInvoice(result.orderId, cart, subtotal, tax, total, paidAmount, orderType);
    cart = [];
    updateCartUI();
    await filterPOS(currentCategory);
}

// ========== طباعة الفاتورة ==========
async function printInvoice(orderId, items, subtotal, tax, total, paidAmount, orderType) {
    const dateStr = new Date().toLocaleString('ar-SA');
    const change = paidAmount - total;
    let rows = items.map(i => `<tr><td>${i.name}</td><td style="text-align:center;">${i.qty}</td><td style="text-align:left;">${(i.price * i.qty).toFixed(2)}</td></tr>`).join('');

    const html = `
    <!DOCTYPE html>
    <html dir="rtl">
    <head><meta charset="UTF-8"><style>
        @page { size: 74mm auto; margin: 0; }
        body { font-family: 'Tajawal', sans-serif; direction: rtl; width: 74mm; margin: 0 auto; padding: 2mm; font-size: 12px; background: white; color: black; }
        .receipt-header { text-align: center; border-bottom: 1px dashed #000; padding-bottom: 4px; margin-bottom: 6px; }
        .receipt-header h3 { font-size: 14px; font-weight: 800; margin: 0 0 2px; }
        .receipt-header p { font-size: 10px; margin: 2px 0; }
        .receipt-table { width: 100%; border-collapse: collapse; margin-top: 4px; }
        .receipt-table th, .receipt-table td { font-size: 11px; padding: 3px 2px; text-align: right; border-bottom: 1px dotted #ccc; }
        .receipt-table th { font-weight: 700; border-bottom: 1px solid #000; }
        .receipt-divider { border-top: 1px dashed #000; margin: 6px 0; }
        .receipt-total-row { display: flex; justify-content: space-between; font-size: 13px; font-weight: 800; padding: 2px 0; }
        .receipt-footer { text-align: center; font-size: 9px; margin-top: 10px; border-top: 1px dashed #000; padding-top: 4px; }
    </style></head>
    <body>
        <div class="receipt-header">
            <h3>${currentCompany.name}</h3>
            <p>📞 ${currentCompany.phone || ''}</p>
            <p>📍 ${currentCompany.address || ''}</p>
            ${currentCompany.tax_number ? `<p>الرقم الضريبي: ${currentCompany.tax_number}</p>` : ''}
            <p>رقم الفاتورة: #${orderId}</p>
            <p>${dateStr}</p>
            <p>طريقة الدفع: ${selectedPayment === 'cash' ? 'نقدي' : selectedPayment === 'card' ? 'بطاقة' : 'تحويل بنكي'}</p>
            <p style="font-weight:800; font-size:13px;">نوع الطلب: ${orderType || 'سفري'}</p>
        </div>
        <table class="receipt-table">
            <thead><tr><th>الصنف</th><th style="text-align:center; width:30px;">كم</th><th style="text-align:left; width:50px;">السعر</th></tr></thead>
            <tbody>${rows}</tbody>
        </table>
        <div class="receipt-divider"></div>
        <div class="receipt-total-row"><span>المجموع</span><span>${subtotal.toFixed(2)} ر.س</span></div>
        <div class="receipt-total-row"><span>الضريبة (${taxRate}%)</span><span>${tax.toFixed(2)} ر.س</span></div>
        <div class="receipt-total-row" style="font-size:15px;"><span>الإجمالي</span><span>${total.toFixed(2)} ر.س</span></div>
        ${selectedPayment === 'cash' ? `<div class="receipt-total-row"><span>المدفوع</span><span>${paidAmount.toFixed(2)} ر.س</span></div>
        <div class="receipt-total-row"><span>الباقي</span><span>${change.toFixed(2)} ر.س</span></div>` : ''}
        <div class="receipt-footer"><p>شكراً لزيارتكم</p><p>تصميم م/ عبدالرحمن الاكوع - 773579486 967+</p></div>
    </body></html>`;

    try {
        await ipcRenderer.invoke('print-thermal', { html, userId: currentUser.id });
    } catch(e) {
        const win = window.open('', '_blank', 'width=300,height=500');
        win.document.write(html);
        win.document.close();
        win.focus();
        win.print();
        win.close();
    }
}

// ========== إرجاع الطلب ==========
function openRefundModal() {
    document.getElementById('refund-modal').style.display = 'flex';
    document.getElementById('refund-order-id').value = '';
    document.getElementById('refund-reason').value = '';
}

async function processRefund() {
    const orderId = parseInt(document.getElementById('refund-order-id').value);
    const reason = document.getElementById('refund-reason').value.trim();
    if (!orderId) { alert('أدخل رقم الطلب'); return; }
    if (!reason) { alert('أدخل سبب الإرجاع'); return; }
    const result = await ipcRenderer.invoke('refund-order', { orderId, userId: currentUser.id, reason });
    if (result.success) {
        alert(`تم إرجاع الطلب #${orderId} بنجاح`);
        document.getElementById('refund-modal').style.display = 'none';
    } else {
        alert('فشل الإرجاع: ' + (result.error || ''));
    }
}

// ========== إغلاق الوردية ==========
async function closeShift() {
    const perms = currentUser.permissions || {};
    if (!perms.can_close_shift) {
        alert('ليس لديك صلاحية لإغلاق الوردية');
        return;
    }
    const actual = prompt('أدخل النقد الفعلي بالدرج (ر.س):');
    if (actual === null) return;
    const actualCash = parseFloat(actual);
    if (isNaN(actualCash)) return;

    const result = await ipcRenderer.invoke('close-shift', { shiftId: currentShiftId, actual_cash: actualCash, userId: currentUser.id });
    if (!result.success) {
        alert('فشل إغلاق الوردية: ' + (result.error || ''));
        return;
    }

    const diff = result.difference;
    const html = `
    <!DOCTYPE html>
    <html dir="rtl">
    <head><meta charset="UTF-8"><style>
        @page { size: 74mm auto; margin: 0; }
        body { font-family: 'Tajawal', sans-serif; direction: rtl; width: 74mm; margin: 0 auto; padding: 2mm; font-size: 12px; }
        .header { text-align: center; border-bottom: 1px dashed #000; padding-bottom: 4px; }
        .row { display: flex; justify-content: space-between; padding: 3px 0; }
        .total { font-weight: 800; font-size: 13px; border-top: 1px dashed #000; padding-top: 4px; margin-top: 4px; }
        .footer { text-align: center; font-size: 9px; border-top: 1px dashed #000; padding-top: 4px; margin-top: 8px; }
    </style></head>
    <body>
        <div class="header">
            <h3>تقرير إغلاق الوردية</h3>
            <p>${new Date().toLocaleString('ar-SA')}</p>
            <p>${currentCompany.name}</p>
        </div>
        <div class="row"><span>إجمالي المبيعات:</span><span>${totalSalesCash.toFixed(2)} ر.س</span></div>
        <div class="row"><span>الكاش الفعلي:</span><span>${actualCash.toFixed(2)} ر.س</span></div>
        <div class="row total"><span>الفارق:</span><span>${diff.toFixed(2)} (${diff >= 0 ? 'فائض' : 'عجز'})</span></div>
        <div class="footer"><p>تصميم م/ عبدالرحمن الاكوع - 773579486 967+</p></div>
    </body></html>`;

    try {
        await ipcRenderer.invoke('print-thermal', { html, userId: currentUser.id });
    } catch(e) {
        const win = window.open('', '_blank', 'width=300,height=400');
        win.document.write(html);
        win.document.close();
        win.focus();
        win.print();
        win.close();
    }
    alert('تم إغلاق الوردية');
    location.reload();
}

// ========== إدارة المنتجات ==========
async function renderProducts() {
    const perms = currentUser.permissions || {};
    const products = await ipcRenderer.invoke('db-query',
        "SELECT p.*, c.name as cat FROM products p LEFT JOIN categories c ON p.category_id=c.id WHERE p.company_id=?",
        [currentCompany.id]
    );
    document.getElementById('main-content').innerHTML = `
        <div class="page-header"><h1>المنتجات</h1>
            ${perms.can_edit_products ? `<button class="btn btn-primary" onclick="openProductModal()">إضافة منتج</button>` : ''}
        </div>
        <table><tr><th>الاسم</th><th>القسم</th><th>سعر البيع</th><th>التكلفة</th>
        ${perms.can_edit_products ? '<th></th>' : ''}</tr>
        ${products.map(p => `<tr>
            <td>${p.name}</td><td>${p.cat || ''}</td>
            <td>${p.price.toFixed(2)}</td><td>${(p.cost || 0).toFixed(2)}</td>
            ${perms.can_edit_products ? `<td><button class="btn btn-sm btn-primary" onclick="editProduct(${p.id})">تعديل</button>
            <button class="btn btn-sm btn-danger" onclick="deleteProduct(${p.id})">حذف</button></td>` : ''}
        </tr>`).join('')}</table>
    `;
}

async function openProductModal(id = null) {
    const perms = currentUser.permissions || {};
    if (!perms.can_edit_products) { alert('ليس لديك صلاحية'); return; }

    let product = { id: null, name: '', price: '', cost: '', category_id: '', image: '' };
    if (id) {
        product = await ipcRenderer.invoke('db-get', "SELECT * FROM products WHERE id=? AND company_id=?", [id, currentCompany.id]);
        if (!product) product = { id: null, name: '', price: '', cost: '', category_id: '', image: '' };
    }
    const categories = await ipcRenderer.invoke('db-query', "SELECT * FROM categories WHERE company_id=?", [currentCompany.id]);
    const catOpts = categories.map(c => `<option value="${c.id}" ${c.id == product.category_id ? 'selected' : ''}>${c.name}</option>`).join('');

    const modalContent = document.getElementById('modal-content');
    modalContent.innerHTML = `
        <h3>${id ? 'تعديل' : 'إضافة'} منتج</h3>
        <div class="form-group"><label>الاسم</label><input type="text" id="prod-name" value="${product.name || ''}"></div>
        <div class="form-group"><label>سعر البيع (ر.س)</label><input type="number" id="prod-price" value="${product.price || ''}" step="0.01"></div>
        <div class="form-group"><label>سعر الشراء (ر.س)</label><input type="number" id="prod-cost" value="${product.cost || ''}" step="0.01"></div>
        <div class="form-group"><label>القسم</label><select id="prod-category">${catOpts}</select></div>
        <div class="form-group"><label>الوحدة</label><input type="text" id="prod-unit" value="${product.unit || 'قطعة'}"></div>
        <div class="form-group">
            <label>صورة المنتج</label>
            <div id="prod-image-preview" style="margin-bottom:5px;">
                ${product.image && userDataPath ? `<img src="file://${userDataPath}/${product.image}" style="max-width:100px; max-height:100px; border:1px solid #ddd; border-radius:4px;">` : ''}
            </div>
            <input type="file" id="prod-image-input" accept="image/*" style="display:block; margin-top:5px;">
        </div>
        <button class="btn btn-primary" onclick="saveProduct(${id})">حفظ</button>
        <button class="btn btn-secondary" onclick="closeModal()">إلغاء</button>
    `;
    document.getElementById('modal').classList.add('active');

    document.getElementById('prod-image-input').addEventListener('change', function(e) {
        const file = e.target.files[0];
        if (file) {
            const reader = new FileReader();
            reader.onload = (ev) => {
                const preview = document.getElementById('prod-image-preview');
                preview.innerHTML = `<img src="${ev.target.result}" style="max-width:100px; max-height:100px; border:1px solid #ddd; border-radius:4px;">`;
            };
            reader.readAsDataURL(file);
        }
    });
}

async function saveProduct(id) {
    const name = document.getElementById('prod-name').value.trim();
    const price = parseFloat(document.getElementById('prod-price').value);
    const cost = parseFloat(document.getElementById('prod-cost').value) || 0;
    const category_id = document.getElementById('prod-category').value || null;
    const unit = document.getElementById('prod-unit').value.trim() || 'قطعة';
    if (!name || isNaN(price)) { alert('الاسم والسعر مطلوبان'); return; }

    let imagePath = null;
    const fileInput = document.getElementById('prod-image-input');
    if (fileInput.files && fileInput.files[0]) {
        const file = fileInput.files[0];
        const reader = new FileReader();
        const buffer = await new Promise((resolve) => {
            reader.onload = (e) => resolve(e.target.result.split(',')[1]);
            reader.readAsDataURL(file);
        });
        const fileName = `product_${Date.now()}_${file.name}`;
        const result = await ipcRenderer.invoke('save-product-image', { fileName, buffer });
        if (result.success) imagePath = result.imagePath;
    } else if (id) {
        const old = await ipcRenderer.invoke('db-get', "SELECT image FROM products WHERE id=?", [id]);
        if (old && old.image) imagePath = old.image;
    }

    await ipcRenderer.invoke('save-product', {
        id: id || null,
        company_id: currentCompany.id,
        name, price, cost, category_id,
        unit, image: imagePath || '',
        userId: currentUser.id
    });
    closeModal();
    switchTab('products');
}

function editProduct(id) { openProductModal(id); }

async function deleteProduct(id) {
    if (!confirm('حذف المنتج نهائياً؟')) return;
    await ipcRenderer.invoke('delete-product', { id, company_id: currentCompany.id, userId: currentUser.id });
    switchTab('products');
}

// ========== إدارة الأقسام ==========
async function renderCategories() {
    const perms = currentUser.permissions || {};
    const categories = await ipcRenderer.invoke('db-query', "SELECT * FROM categories WHERE company_id=?", [currentCompany.id]);
    document.getElementById('main-content').innerHTML = `
        <div class="page-header"><h1>الأقسام</h1>
            ${perms.can_edit_products ? `<button class="btn btn-primary" onclick="openCategoryModal()">إضافة قسم</button>` : ''}
        </div>
        <table><tr><th>الاسم</th>${perms.can_edit_products ? '<th></th>' : ''}</tr>
        ${categories.map(c => `<tr><td>${c.name}</td>
            ${perms.can_edit_products ? `<td><button class="btn btn-sm btn-danger" onclick="deleteCategory(${c.id})">حذف</button></td>` : ''}
        </tr>`).join('')}</table>
    `;
}

function openCategoryModal() {
    const modalContent = document.getElementById('modal-content');
    modalContent.innerHTML = `
        <h3>إضافة قسم</h3>
        <div class="form-group"><label>اسم القسم</label><input type="text" id="cat-name"></div>
        <button class="btn btn-primary" onclick="saveCategory()">حفظ</button>
        <button class="btn btn-secondary" onclick="closeModal()">إلغاء</button>
    `;
    document.getElementById('modal').classList.add('active');
}

async function saveCategory() {
    const name = document.getElementById('cat-name').value.trim();
    if (!name) { alert('أدخل اسم القسم'); return; }
    await ipcRenderer.invoke('save-category', { company_id: currentCompany.id, name, userId: currentUser.id });
    closeModal();
    switchTab('categories');
}

async function deleteCategory(id) {
    if (!confirm('حذف القسم؟')) return;
    await ipcRenderer.invoke('delete-category', { id, userId: currentUser.id });
    switchTab('categories');
}

// ========== إدارة المواد الخام ==========
async function renderMaterials() {
    const perms = currentUser.permissions || {};
    const materials = await ipcRenderer.invoke('db-query', "SELECT * FROM raw_materials WHERE company_id=?", [currentCompany.id]);
    document.getElementById('main-content').innerHTML = `
        <div class="page-header"><h1>المواد الخام</h1>
            ${perms.can_edit_products ? `<button class="btn btn-primary" onclick="openMaterialModal()">إضافة مادة</button>` : ''}
        </div>
        <table><tr><th>الاسم</th><th>المخزون</th><th>الوحدة</th><th>الحد الأدنى</th><th>سعر الشراء</th>
        ${perms.can_edit_products ? '<th></th>' : ''}</tr>
        ${materials.map(m => `<tr class="${m.current_stock <= m.min_stock ? 'stock-danger' : ''}">
            <td>${m.name}</td><td>${m.current_stock}</td><td>${m.unit}</td>
            <td>${m.min_stock}</td><td>${(m.purchase_price || 0).toFixed(2)}</td>
            ${perms.can_edit_products ? `<td><button class="btn btn-sm btn-success" onclick="addStock(${m.id})">توريد</button>
            <button class="btn btn-sm btn-primary" onclick="editMaterial(${m.id})">تعديل</button>
            <button class="btn btn-sm btn-danger" onclick="deleteMaterial(${m.id})">حذف</button></td>` : ''}
        </tr>`).join('')}</table>
    `;
}

function openMaterialModal(id = null) {
    const modalContent = document.getElementById('modal-content');
    modalContent.innerHTML = `
        <h3>${id ? 'تعديل' : 'إضافة'} مادة</h3>
        <div class="form-group"><label>الاسم</label><input type="text" id="mat-name"></div>
        <div class="form-group"><label>الوحدة</label><input type="text" id="mat-unit" value="كجم"></div>
        <div class="form-group"><label>الحد الأدنى</label><input type="number" id="mat-min" value="0"></div>
        <div class="form-group"><label>سعر الشراء</label><input type="number" id="mat-price" value="0" step="0.01"></div>
        <button class="btn btn-primary" onclick="saveMaterial(${id})">حفظ</button>
        <button class="btn btn-secondary" onclick="closeModal()">إلغاء</button>
    `;
    document.getElementById('modal').classList.add('active');
    if (id) {
        // جلب البيانات (يمكن تحسينها)
    }
}

async function saveMaterial(id) {
    const name = document.getElementById('mat-name').value.trim();
    const unit = document.getElementById('mat-unit').value.trim();
    const min_stock = parseFloat(document.getElementById('mat-min').value) || 0;
    const purchase_price = parseFloat(document.getElementById('mat-price').value) || 0;
    if (!name) { alert('الاسم مطلوب'); return; }
    await ipcRenderer.invoke('save-material', {
        id: id || null, company_id: currentCompany.id, name, unit, min_stock, purchase_price
    });
    closeModal();
    switchTab('materials');
}

function editMaterial(id) { openMaterialModal(id); }

async function deleteMaterial(id) {
    if (!confirm('حذف المادة؟')) return;
    await ipcRenderer.invoke('delete-material', { id, company_id: currentCompany.id });
    switchTab('materials');
}

async function addStock(id) {
    const qty = prompt('أدخل كمية التوريد:');
    if (qty === null || isNaN(qty) || parseFloat(qty) <= 0) return;
    await ipcRenderer.invoke('add-stock', { material_id: id, qty: parseFloat(qty), userId: currentUser.id });
    switchTab('materials');
}

// ========== إدارة الطاولات ==========
async function renderTables() {
    const tables = await ipcRenderer.invoke('db-query', "SELECT * FROM tables WHERE company_id=?", [currentCompany.id]);
    document.getElementById('main-content').innerHTML = `
        <div class="page-header"><h1>الطاولات</h1><button class="btn btn-primary" onclick="openTableModal()">إضافة طاولة</button></div>
        <div class="stats-grid">
            ${tables.map(t => `<div class="stat-card"><div><h3>${t.name}</h3><p>${t.status === 'free' ? '🟢 متاحة' : '🔴 مشغولة'}</p>
                <button class="btn btn-sm btn-danger" onclick="deleteTable(${t.id})">حذف</button></div></div>`).join('')}
        </div>
    `;
}

function openTableModal() {
    const modalContent = document.getElementById('modal-content');
    modalContent.innerHTML = `
        <h3>إضافة طاولة</h3>
        <div class="form-group"><label>اسم الطاولة</label><input type="text" id="table-name"></div>
        <button class="btn btn-primary" onclick="saveTable()">حفظ</button>
        <button class="btn btn-secondary" onclick="closeModal()">إلغاء</button>
    `;
    document.getElementById('modal').classList.add('active');
}

async function saveTable() {
    const name = document.getElementById('table-name').value.trim();
    if (!name) { alert('أدخل اسم الطاولة'); return; }
    await ipcRenderer.invoke('save-table', { company_id: currentCompany.id, name });
    closeModal();
    switchTab('tables');
}

async function deleteTable(id) {
    if (!confirm('حذف الطاولة؟')) return;
    await ipcRenderer.invoke('delete-table', { id });
    switchTab('tables');
}

// ========== إدارة الكباتن ==========
async function renderWaiters() {
    const waiters = await ipcRenderer.invoke('db-query', "SELECT * FROM waiters WHERE company_id=?", [currentCompany.id]);
    document.getElementById('main-content').innerHTML = `
        <div class="page-header"><h1>الكباتن</h1><button class="btn btn-primary" onclick="openWaiterModal()">إضافة كابتن</button></div>
        <table><tr><th>الاسم</th><th></th></tr>
        ${waiters.map(w => `<tr><td>${w.name}</td><td><button class="btn btn-sm btn-danger" onclick="deleteWaiter(${w.id})">حذف</button></td></tr>`).join('')}
        </table>
    `;
}

function openWaiterModal() {
    const modalContent = document.getElementById('modal-content');
    modalContent.innerHTML = `
        <h3>إضافة كابتن</h3>
        <div class="form-group"><label>اسم الكابتن</label><input type="text" id="waiter-name"></div>
        <button class="btn btn-primary" onclick="saveWaiter()">حفظ</button>
        <button class="btn btn-secondary" onclick="closeModal()">إلغاء</button>
    `;
    document.getElementById('modal').classList.add('active');
}

async function saveWaiter() {
    const name = document.getElementById('waiter-name').value.trim();
    if (!name) { alert('أدخل اسم الكابتن'); return; }
    await ipcRenderer.invoke('save-waiter', { company_id: currentCompany.id, name });
    closeModal();
    switchTab('waiters');
}

async function deleteWaiter(id) {
    if (!confirm('حذف الكابتن؟')) return;
    await ipcRenderer.invoke('delete-waiter', { id });
    switchTab('waiters');
}

// ========== التقارير ==========
async function renderReports() {
    document.getElementById('main-content').innerHTML = `
        <div class="page-header"><h1>التقارير</h1></div>
        <div style="display:flex; gap:10px; flex-wrap:wrap; margin-bottom:20px;">
            <div class="form-group" style="flex:1; min-width:150px;"><label>من تاريخ</label><input type="date" id="report-start"></div>
            <div class="form-group" style="flex:1; min-width:150px;"><label>إلى تاريخ</label><input type="date" id="report-end"></div>
            <button class="btn btn-primary" onclick="generateReports()" style="align-self:flex-end;">عرض التقارير</button>
        </div>
        <div id="report-results"></div>
    `;
    const today = new Date().toISOString().slice(0,10);
    const weekAgo = new Date(Date.now() - 7*24*60*60*1000).toISOString().slice(0,10);
    document.getElementById('report-start').value = weekAgo;
    document.getElementById('report-end').value = today;
}

async function generateReports() {
    const start = document.getElementById('report-start').value;
    const end = document.getElementById('report-end').value;
    if (!start || !end) { alert('اختر التواريخ'); return; }

    const sales = await ipcRenderer.invoke('get-sales-report', { startDate: start, endDate: end, companyId: currentCompany.id });
    const profit = await ipcRenderer.invoke('get-profit-report', { startDate: start, endDate: end, companyId: currentCompany.id });
    const expenses = await ipcRenderer.invoke('get-expense-report', { startDate: start, endDate: end, companyId: currentCompany.id });

    const totalSales = sales.reduce((s, r) => s + r.total, 0);
    const totalTax = sales.reduce((s, r) => s + (r.tax || 0), 0);
    const totalExpenses = expenses.reduce((s, e) => s + e.total, 0);
    const netProfit = (profit.profit || 0) - totalExpenses;

    document.getElementById('report-results').innerHTML = `
        <div class="stats-grid">
            <div class="stat-card"><div class="stat-icon"><i class="fas fa-chart-simple"></i></div><div class="stat-info"><h3>إجمالي المبيعات</h3><p>${totalSales.toFixed(2)} ر.س</p></div></div>
            <div class="stat-card"><div class="stat-icon"><i class="fas fa-percent"></i></div><div class="stat-info"><h3>الضريبة</h3><p>${totalTax.toFixed(2)} ر.س</p></div></div>
            <div class="stat-card"><div class="stat-icon"><i class="fas fa-coins"></i></div><div class="stat-info"><h3>الأرباح الخام</h3><p>${(profit.profit || 0).toFixed(2)} ر.س</p></div></div>
            <div class="stat-card"><div class="stat-icon"><i class="fas fa-money-bill-wave"></i></div><div class="stat-info"><h3>المصروفات</h3><p>${totalExpenses.toFixed(2)} ر.س</p></div></div>
            <div class="stat-card"><div class="stat-icon"><i class="fas fa-trophy"></i></div><div class="stat-info"><h3>صافي الربح</h3><p>${netProfit.toFixed(2)} ر.س</p></div></div>
        </div>
        <h4>تفاصيل المبيعات</h4>
        <table><tr><th>التاريخ</th><th>العدد</th><th>الإجمالي</th><th>الضريبة</th><th>طريقة الدفع</th></tr>
        ${sales.map(s => `<tr><td>${s.date}</td><td>${s.count}</td><td>${s.total.toFixed(2)}</td><td>${(s.tax || 0).toFixed(2)}</td><td>${s.payment_method}</td></tr>`).join('')}</table>
        <h4>المصروفات</h4>
        <table><tr><th>الفئة</th><th>الإجمالي</th></tr>
        ${expenses.map(e => `<tr><td>${e.category}</td><td>${e.total.toFixed(2)}</td></tr>`).join('')}</table>
    `;
}

// ========== المصروفات ==========
async function renderExpenses() {
    const month = new Date().toISOString().slice(0,7);
    const expenses = await ipcRenderer.invoke('db-query', "SELECT * FROM expenses WHERE company_id=? AND month=?", [currentCompany.id, month]);
    document.getElementById('main-content').innerHTML = `
        <div class="page-header"><h1>المصروفات - ${month}</h1>
            <button class="btn btn-primary" onclick="openExpenseModal()">إضافة مصروف</button>
        </div>
        <table><tr><th>الفئة</th><th>الوصف</th><th>المبلغ (ر.س)</th><th>النوع</th><th></th></tr>
        ${expenses.map(e => `<tr><td>${e.category}</td><td>${e.description}</td><td>${e.amount.toFixed(2)}</td><td>${e.type === 'fixed' ? 'ثابتة' : 'متغيرة'}</td>
            <td><button class="btn btn-sm btn-danger" onclick="deleteExpense(${e.id})">حذف</button></td></tr>`).join('')}
        </table>
    `;
}

function openExpenseModal() {
    const modalContent = document.getElementById('modal-content');
    const month = new Date().toISOString().slice(0,7);
    modalContent.innerHTML = `
        <h3>إضافة مصروف</h3>
        <div class="form-group"><label>الفئة</label><input type="text" id="exp-category" placeholder="مثال: رواتب"></div>
        <div class="form-group"><label>الوصف</label><input type="text" id="exp-description" placeholder="وصف المصروف"></div>
        <div class="form-group"><label>المبلغ (ر.س)</label><input type="number" id="exp-amount" step="0.01"></div>
        <div class="form-group"><label>النوع</label>
            <select id="exp-type"><option value="fixed">ثابتة</option><option value="variable">متغيرة</option></select>
        </div>
        <button class="btn btn-primary" onclick="saveExpense()">حفظ</button>
        <button class="btn btn-secondary" onclick="closeModal()">إلغاء</button>
    `;
    document.getElementById('modal').classList.add('active');
}

async function saveExpense() {
    const category = document.getElementById('exp-category').value.trim();
    const description = document.getElementById('exp-description').value.trim();
    const amount = parseFloat(document.getElementById('exp-amount').value);
    const type = document.getElementById('exp-type').value;
    if (!category || isNaN(amount) || amount <= 0) { alert('أكمل البيانات بشكل صحيح'); return; }
    const month = new Date().toISOString().slice(0,7);
    await ipcRenderer.invoke('add-expense', {
        company_id: currentCompany.id, month, category, description, amount, type, user_id: currentUser.id
    });
    closeModal();
    switchTab('expenses');
}

async function deleteExpense(id) {
    if (!confirm('حذف المصروف؟')) return;
    await ipcRenderer.invoke('delete-expense', { id, userId: currentUser.id });
    switchTab('expenses');
}

// ========== سجل التدقيق ==========
async function renderAudit() {
    const logs = await ipcRenderer.invoke('get-audit-log', { limit: 200 });
    document.getElementById('main-content').innerHTML = `
        <div class="page-header"><h1>سجل التدقيق</h1></div>
        <table><tr><th>التاريخ</th><th>المستخدم</th><th>الإجراء</th><th>التفاصيل</th></tr>
        ${logs.map(l => `<tr><td>${l.date}</td><td>${l.user_id}</td><td>${l.action}</td><td>${l.details || ''}</td></tr>`).join('')}
        </table>
    `;
}

// ========== المستخدمين ==========
async function renderUsers() {
    const perms = currentUser.permissions || {};
    if (!perms.can_edit_users) {
        document.getElementById('main-content').innerHTML = '<div class="alert-warning">ليس لديك صلاحية لعرض هذه الصفحة</div>';
        return;
    }
    const users = await ipcRenderer.invoke('db-query', "SELECT * FROM users WHERE company_id=?", [currentCompany.id]);
    document.getElementById('main-content').innerHTML = `
        <div class="page-header"><h1>المستخدمين</h1>
            <button class="btn btn-primary" onclick="openUserModal()">إضافة مستخدم</button>
        </div>
        <table><tr><th>الاسم</th><th>اسم المستخدم</th><th>الدور</th><th>محظور</th><th></th></tr>
        ${users.map(u => `<tr>
            <td>${u.full_name}</td><td>${u.username}</td>
            <td>${u.role === 'admin' ? 'مدير' : u.role === 'accountant' ? 'محاسب' : 'كاشير'}</td>
            <td>${u.is_blocked ? 'نعم' : 'لا'}</td>
            <td><button class="btn btn-sm btn-primary" onclick="editUser(${u.id})">تعديل</button>
            <button class="btn btn-sm btn-danger" onclick="toggleBlockUser(${u.id})">${u.is_blocked ? 'فك الحظر' : 'حظر'}</button></td>
        </tr>`).join('')}</table>
    `;
}

async function openUserModal(id = null) {
    let user = { id: null, full_name: '', username: '', role: 'cashier' };
    if (id) {
        user = await ipcRenderer.invoke('db-get', "SELECT * FROM users WHERE id=? AND company_id=?", [id, currentCompany.id]);
        if (!user) user = { id: null, full_name: '', username: '', role: 'cashier' };
    }
    const modalContent = document.getElementById('modal-content');
    modalContent.innerHTML = `
        <h3>${id ? 'تعديل' : 'إضافة'} مستخدم</h3>
        <div class="form-group"><label>الاسم الكامل</label><input type="text" id="user-fullname" value="${user.full_name || ''}"></div>
        <div class="form-group"><label>اسم المستخدم</label><input type="text" id="user-username" value="${user.username || ''}"></div>
        <div class="form-group"><label>كلمة المرور ${id ? '(اترك فارغاً للتعديل)' : ''}</label>
            <input type="password" id="user-password" placeholder="${id ? 'أدخل كلمة جديدة لتغييرها' : 'كلمة المرور'}">
        </div>
        <div class="form-group"><label>الدور</label>
            <select id="user-role">
                <option value="admin" ${user.role === 'admin' ? 'selected' : ''}>مدير عام</option>
                <option value="accountant" ${user.role === 'accountant' ? 'selected' : ''}>محاسب</option>
                <option value="cashier" ${user.role === 'cashier' ? 'selected' : ''}>كاشير</option>
            </select>
        </div>
        <button class="btn btn-primary" onclick="saveUser(${id})">حفظ</button>
        <button class="btn btn-secondary" onclick="closeModal()">إلغاء</button>
    `;
    document.getElementById('modal').classList.add('active');
}

async function saveUser(id) {
    const full_name = document.getElementById('user-fullname').value.trim();
    const username = document.getElementById('user-username').value.trim();
    const password = document.getElementById('user-password').value;
    const role = document.getElementById('user-role').value;
    if (!full_name || !username) { alert('الاسم واسم المستخدم مطلوبان'); return; }

    if (id) {
        const result = await ipcRenderer.invoke('update-user', {
            id, full_name, username, password: password || null, role, currentUserId: currentUser.id
        });
        if (!result.success) { alert('فشل التحديث: ' + (result.error || '')); return; }
    } else {
        if (!password) { alert('كلمة المرور مطلوبة'); return; }
        const result = await ipcRenderer.invoke('create-user', {
            company_id: currentCompany.id, full_name, username, password, role, currentUserId: currentUser.id
        });
        if (!result.success) { alert('فشل الإضافة: ' + (result.error || '')); return; }
    }
    closeModal();
    switchTab('users');
}

function editUser(id) { openUserModal(id); }

async function toggleBlockUser(userId) {
    if (userId === currentUser.id) { alert('لا يمكنك حظر نفسك'); return; }
    await ipcRenderer.invoke('toggle-block', { userId, currentUserId: currentUser.id });
    switchTab('users');
}

// ========== الإعدادات ==========
async function renderSettings() {
    document.getElementById('main-content').innerHTML = `
        <div class="page-header"><h1>الإعدادات</h1></div>
        <div style="background:white; padding:20px; border-radius:10px; box-shadow:0 2px 8px rgba(0,0,0,0.08);">
            <h3>الحساب الشخصي</h3>
            <p><strong>اسم المستخدم:</strong> ${currentUser.username}</p>
            <p><strong>الدور:</strong> ${currentUser.role === 'admin' ? 'مدير' : currentUser.role === 'accountant' ? 'محاسب' : 'كاشير'}</p>
            <button class="btn btn-primary" onclick="openPasswordModal()">تغيير كلمة المرور</button>
            <hr style="margin:20px 0;">
            <h3>بيانات المطعم</h3>
            <p><strong>الاسم:</strong> ${currentCompany.name}</p>
            <p><strong>الهاتف:</strong> ${currentCompany.phone || 'غير محدد'}</p>
            <p><strong>العنوان:</strong> ${currentCompany.address || 'غير محدد'}</p>
            <p><strong>الرقم الضريبي:</strong> ${currentCompany.tax_number || 'غير محدد'}</p>
            <p><strong>نسبة الضريبة:</strong> ${taxRate || 0}%</p>
            <button class="btn btn-primary" onclick="openCompanyModal()">تعديل بيانات المطعم</button>
            <hr style="margin:20px 0;">
            <h3>النسخ الاحتياطي</h3>
            <button class="btn btn-secondary" onclick="manualBackup()">نسخ احتياطي يدوي</button>
        </div>
    `;
}

function openPasswordModal() {
    document.getElementById('password-modal').style.display = 'flex';
    document.getElementById('old-password').value = '';
    document.getElementById('new-password').value = '';
    document.getElementById('confirm-password').value = '';
}

async function changePassword() {
    const oldPassword = document.getElementById('old-password').value;
    const newPassword = document.getElementById('new-password').value;
    const confirmPassword = document.getElementById('confirm-password').value;
    if (!oldPassword || !newPassword) { alert('أدخل كلمة المرور الحالية والجديدة'); return; }
    if (newPassword !== confirmPassword) { alert('كلمة المرور الجديدة غير متطابقة'); return; }
    if (newPassword.length < 6) { alert('كلمة المرور يجب أن تكون 6 أحرف على الأقل'); return; }

    const result = await ipcRenderer.invoke('login', { username: currentUser.username, password: oldPassword });
    if (!result.success) { alert('كلمة المرور الحالية خاطئة'); return; }

    const updateResult = await ipcRenderer.invoke('update-user', {
        id: currentUser.id,
        full_name: currentUser.full_name,
        username: currentUser.username,
        password: newPassword,
        role: currentUser.role,
        currentUserId: currentUser.id
    });
    if (updateResult.success) {
        alert('تم تغيير كلمة المرور بنجاح');
        document.getElementById('password-modal').style.display = 'none';
    } else {
        alert('فشل تغيير كلمة المرور: ' + (updateResult.error || ''));
    }
}

async function manualBackup() {
    const result = await ipcRenderer.invoke('manual-backup');
    if (result.success) alert(`تم النسخ الاحتياطي في: ${result.path}`);
    else alert('فشل النسخ الاحتياطي');
}

// ========== دوال مساعدة ==========
function closeModal() {
    document.getElementById('modal').classList.remove('active');
    document.getElementById('password-modal').style.display = 'none';
}

// ========== لوحة المفاتيح اللمسية ==========
document.addEventListener('DOMContentLoaded', () => {
    const toggleBtn = document.getElementById('toggle-keyboard-btn');
    const keyboard = document.getElementById('touch-keyboard');
    const closeBtn = document.getElementById('kb-close');

    if (toggleBtn && keyboard) {
        toggleBtn.addEventListener('click', () => {
            keyboard.style.display = keyboard.style.display === 'none' ? 'block' : 'none';
        });
    }
    if (closeBtn) {
        closeBtn.addEventListener('click', () => {
            keyboard.style.display = 'none';
        });
    }

    // إدخال الأحرف في الحقل المحدد
    document.querySelectorAll('.kb-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            const char = btn.dataset.char;
            const activeElement = document.activeElement;
            if (!activeElement || !['INPUT', 'TEXTAREA'].includes(activeElement.tagName)) {
                // إذا لم يكن هناك حقل نشط، حاول البحث عن حقل في الصفحة
                const inputs = document.querySelectorAll('input[type="text"], input[type="number"], input[type="password"], textarea');
                if (inputs.length > 0) {
                    inputs[0].focus();
                }
                return;
            }
            if (char === 'backspace') {
                const start = activeElement.selectionStart;
                const end = activeElement.selectionEnd;
                const value = activeElement.value;
                activeElement.value = value.substring(0, start-1) + value.substring(end);
                activeElement.selectionStart = activeElement.selectionEnd = start-1;
            } else if (char === 'space') {
                activeElement.value += ' ';
            } else if (char === 'clear') {
                activeElement.value = '';
            } else {
                activeElement.value += char;
            }
            // إعادة التركيز
            activeElement.focus();
        });
    });
});

// ========== بدء التطبيق ==========
document.addEventListener('DOMContentLoaded', () => {
    document.querySelectorAll('.nav-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            document.querySelectorAll('.nav-btn').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            switchTab(btn.dataset.tab);
        });
    });
});

console.log('✅ نظام تقنيات سوفت المطور جاهز');