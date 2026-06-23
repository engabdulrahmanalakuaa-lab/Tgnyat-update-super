const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const Database = require('better-sqlite3');
const fs = require('fs');
const bcrypt = require('bcryptjs');
const { ThermalPrinter, PrinterTypes } = require('node-thermal-printer');
const pdfMake = require('pdfmake');

let mainWindow;
let db;
const dbDir = app.getPath('userData');
const dbPath = path.join(dbDir, 'technologies_soft.db');
const backupDir = path.join(dbDir, 'backups');
const logsDir = path.join(dbDir, 'logs');
const imagesDir = path.join(dbDir, 'product-images');

if (!fs.existsSync(backupDir)) fs.mkdirSync(backupDir, { recursive: true });
if (!fs.existsSync(logsDir)) fs.mkdirSync(logsDir, { recursive: true });
if (!fs.existsSync(imagesDir)) fs.mkdirSync(imagesDir, { recursive: true });

// ========== تهيئة قاعدة البيانات (better-sqlite3) ==========
function initializeDatabase() {
    db = new Database(dbPath);
    db.pragma('journal_mode = WAL');

    const createTables = `
        CREATE TABLE IF NOT EXISTS companies (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL,
            phone TEXT,
            address TEXT,
            tax_number TEXT,
            tax_rate REAL DEFAULT 0,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        );
        CREATE TABLE IF NOT EXISTS users (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            company_id INTEGER,
            full_name TEXT,
            username TEXT UNIQUE,
            password_hash TEXT,
            role TEXT DEFAULT 'cashier',
            is_blocked INTEGER DEFAULT 0,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY(company_id) REFERENCES companies(id)
        );
        CREATE TABLE IF NOT EXISTS permissions (
            user_id INTEGER PRIMARY KEY,
            can_edit_products INTEGER DEFAULT 0,
            can_edit_prices INTEGER DEFAULT 0,
            can_edit_users INTEGER DEFAULT 0,
            can_view_reports INTEGER DEFAULT 0,
            can_close_shift INTEGER DEFAULT 0,
            can_refund INTEGER DEFAULT 0,
            FOREIGN KEY(user_id) REFERENCES users(id)
        );
        CREATE TABLE IF NOT EXISTS categories (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            company_id INTEGER,
            name TEXT,
            FOREIGN KEY(company_id) REFERENCES companies(id)
        );
        CREATE TABLE IF NOT EXISTS products (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            company_id INTEGER,
            name TEXT,
            category_id INTEGER,
            price REAL,
            cost REAL DEFAULT 0,
            barcode TEXT,
            recipe TEXT,
            image TEXT,
            unit TEXT DEFAULT 'قطعة',
            daily_forecast INTEGER DEFAULT 0,
            monthly_forecast INTEGER DEFAULT 0,
            FOREIGN KEY(company_id) REFERENCES companies(id),
            FOREIGN KEY(category_id) REFERENCES categories(id)
        );
        CREATE TABLE IF NOT EXISTS raw_materials (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            company_id INTEGER,
            name TEXT,
            unit TEXT,
            current_stock REAL DEFAULT 0,
            min_stock REAL DEFAULT 0,
            purchase_price REAL DEFAULT 0,
            FOREIGN KEY(company_id) REFERENCES companies(id)
        );
        CREATE TABLE IF NOT EXISTS tables (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            company_id INTEGER,
            name TEXT,
            status TEXT DEFAULT 'free',
            FOREIGN KEY(company_id) REFERENCES companies(id)
        );
        CREATE TABLE IF NOT EXISTS waiters (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            company_id INTEGER,
            name TEXT,
            user_id INTEGER,
            FOREIGN KEY(company_id) REFERENCES companies(id),
            FOREIGN KEY(user_id) REFERENCES users(id)
        );
        CREATE TABLE IF NOT EXISTS shifts (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            company_id INTEGER,
            user_id INTEGER,
            opening_cash REAL,
            closing_cash REAL,
            expected_cash REAL,
            cash_difference REAL,
            date TEXT,
            status TEXT DEFAULT 'open',
            closed_at DATETIME,
            FOREIGN KEY(company_id) REFERENCES companies(id),
            FOREIGN KEY(user_id) REFERENCES users(id)
        );
        CREATE TABLE IF NOT EXISTS orders (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            company_id INTEGER,
            table_id INTEGER,
            waiter_id INTEGER,
            user_id INTEGER,
            total REAL,
            tax REAL DEFAULT 0,
            total_with_tax REAL,
            discount REAL DEFAULT 0,
            payment_method TEXT DEFAULT 'cash',
            paid_amount REAL,
            change_amount REAL,
            order_type TEXT DEFAULT 'سفري',
            date TEXT,
            time TEXT,
            shift_id INTEGER,
            status TEXT DEFAULT 'completed',
            FOREIGN KEY(company_id) REFERENCES companies(id),
            FOREIGN KEY(table_id) REFERENCES tables(id),
            FOREIGN KEY(waiter_id) REFERENCES waiters(id),
            FOREIGN KEY(user_id) REFERENCES users(id),
            FOREIGN KEY(shift_id) REFERENCES shifts(id)
        );
        CREATE TABLE IF NOT EXISTS order_items (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            order_id INTEGER,
            product_id INTEGER,
            qty INTEGER,
            price REAL,
            FOREIGN KEY(order_id) REFERENCES orders(id),
            FOREIGN KEY(product_id) REFERENCES products(id)
        );
        CREATE TABLE IF NOT EXISTS refunds (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            order_id INTEGER,
            user_id INTEGER,
            amount REAL,
            reason TEXT,
            date TEXT,
            FOREIGN KEY(order_id) REFERENCES orders(id),
            FOREIGN KEY(user_id) REFERENCES users(id)
        );
        CREATE TABLE IF NOT EXISTS inventory_transactions (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            company_id INTEGER,
            material_id INTEGER,
            qty_change REAL,
            type TEXT,
            reference TEXT,
            date TEXT,
            user_id INTEGER,
            FOREIGN KEY(company_id) REFERENCES companies(id),
            FOREIGN KEY(material_id) REFERENCES raw_materials(id),
            FOREIGN KEY(user_id) REFERENCES users(id)
        );
        CREATE TABLE IF NOT EXISTS expenses (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            company_id INTEGER,
            month TEXT,
            category TEXT,
            description TEXT,
            amount REAL,
            type TEXT DEFAULT 'fixed',
            date TEXT,
            user_id INTEGER,
            FOREIGN KEY(company_id) REFERENCES companies(id),
            FOREIGN KEY(user_id) REFERENCES users(id)
        );
        CREATE TABLE IF NOT EXISTS audit_log (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER,
            action TEXT,
            details TEXT,
            ip TEXT,
            date DATETIME DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY(user_id) REFERENCES users(id)
        );
        CREATE TABLE IF NOT EXISTS settings (
            company_id INTEGER PRIMARY KEY,
            safe_mode INTEGER DEFAULT 0,
            currency TEXT DEFAULT 'SAR',
            pagination INTEGER DEFAULT 20,
            show_company_screen INTEGER DEFAULT 1,
            profit_margin_percent REAL DEFAULT 30,
            FOREIGN KEY(company_id) REFERENCES companies(id)
        );
    `;
    db.exec(createTables);

    // التأكد من وجود عمود order_type في قواعد البيانات القديمة
    try { db.exec("ALTER TABLE orders ADD COLUMN order_type TEXT DEFAULT 'سفري'"); } catch (e) {}

    // البيانات الافتراضية
    const row = db.prepare("SELECT COUNT(*) as count FROM companies").get();
    if (!row || row.count === 0) {
        const companyId = 1;
        db.prepare("INSERT INTO companies (id, name, phone, address, tax_rate) VALUES (?, ?, ?, ?, ?)")
          .run(companyId, 'مطعم تقنيات سوفت', '773579486', 'اليمن - صنعاء', 0);

        const hash = bcrypt.hashSync('77357233199477', 10);
        db.prepare("INSERT INTO users (id, company_id, full_name, username, password_hash, role) VALUES (?, ?, ?, ?, ?, ?)")
          .run(1, companyId, 'المدير العام', 'admin', hash, 'admin');
        db.prepare("INSERT INTO permissions (user_id, can_edit_products, can_edit_prices, can_edit_users, can_view_reports, can_close_shift, can_refund) VALUES (?,1,1,1,1,1,1)")
          .run(1);

        const hashAcc = bcrypt.hashSync('77357233199477', 10);
        const accResult = db.prepare("INSERT INTO users (company_id, full_name, username, password_hash, role) VALUES (?, ?, ?, ?, ?)")
          .run(companyId, 'المحاسب', 'accountant', hashAcc, 'accountant');
        db.prepare("INSERT INTO permissions (user_id, can_edit_products, can_edit_prices, can_edit_users, can_view_reports, can_close_shift, can_refund) VALUES (?,0,0,0,1,1,0)")
          .run(accResult.lastInsertRowid);

        const hashCash = bcrypt.hashSync('77357233199477', 10);
        const cashResult = db.prepare("INSERT INTO users (company_id, full_name, username, password_hash, role) VALUES (?, ?, ?, ?, ?)")
          .run(companyId, 'الكاشير', 'cashier', hashCash, 'cashier');
        db.prepare("INSERT INTO permissions (user_id, can_edit_products, can_edit_prices, can_edit_users, can_view_reports, can_close_shift, can_refund) VALUES (?,0,0,0,0,0,0)")
          .run(cashResult.lastInsertRowid);

        db.prepare("INSERT INTO settings (company_id) VALUES (?)").run(companyId);

        const categories = ['أكلات شعبية', 'غداء', 'المعصوب', 'مشروبات'];
        for (let cat of categories) {
            db.prepare("INSERT INTO categories (company_id, name) VALUES (?,?)").run(companyId, cat);
        }
    }
}

function createWindow() {
    mainWindow = new BrowserWindow({
        width: 1280,
        height: 800,
        minWidth: 1024,
        minHeight: 720,
        webPreferences: {
            nodeIntegration: true,
            contextIsolation: false
        }
    });
    mainWindow.loadFile('index.html');
}

app.whenReady().then(() => {
    initializeDatabase();
    createWindow();
});

app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
        if (db) db.close();
        app.quit();
    }
});

// ========== دوال مساعدة ==========
function logAudit(userId, action, details) {
    try {
        db.prepare("INSERT INTO audit_log (user_id, action, details) VALUES (?,?,?)")
          .run(userId, action, details);
    } catch(e) {}
}

function backupDatabase() {
    const backupFile = path.join(backupDir, `backup_${new Date().toISOString().slice(0,10)}.db`);
    try {
        fs.copyFileSync(dbPath, backupFile);
        const files = fs.readdirSync(backupDir).filter(f => f.startsWith('backup_'));
        if (files.length > 7) {
            const sorted = files.sort();
            for (let i = 0; i < sorted.length - 7; i++) {
                fs.unlinkSync(path.join(backupDir, sorted[i]));
            }
        }
        return { success: true, path: backupFile };
    } catch (e) {
        return { success: false, error: e.message };
    }
}

// ========== تغليف دوال better-sqlite3 في Promises للتوافق مع IPC ==========
function dbAll(sql, params = []) {
    return new Promise((resolve, reject) => {
        try {
            const stmt = db.prepare(sql);
            const rows = stmt.all(...params);
            resolve(rows);
        } catch (err) {
            reject(err);
        }
    });
}
function dbGet(sql, params = []) {
    return new Promise((resolve, reject) => {
        try {
            const stmt = db.prepare(sql);
            const row = stmt.get(...params);
            resolve(row);
        } catch (err) {
            reject(err);
        }
    });
}
function dbRun(sql, params = []) {
    return new Promise((resolve, reject) => {
        try {
            const stmt = db.prepare(sql);
            const info = stmt.run(...params);
            resolve({ changes: info.changes, lastInsertRowid: info.lastInsertRowid });
        } catch (err) {
            reject(err);
        }
    });
}

// ========== قنوات IPC الأساسية ==========
ipcMain.handle('db-query', (event, sql, params) => dbAll(sql, params));
ipcMain.handle('db-run', (event, sql, params) => dbRun(sql, params));
ipcMain.handle('db-get', (event, sql, params) => dbGet(sql, params));

// ========== المستخدمين والصلاحيات ==========
ipcMain.handle('login', async (event, { username, password }) => {
    const user = await dbGet("SELECT * FROM users WHERE username=? AND is_blocked=0", [username]);
    if (!user) return { success: false, error: 'اسم المستخدم غير موجود' };
    const valid = bcrypt.compareSync(password, user.password_hash);
    if (!valid) return { success: false, error: 'كلمة المرور خاطئة' };
    const perms = await dbGet("SELECT * FROM permissions WHERE user_id=?", [user.id]) || {};
    logAudit(user.id, 'login', 'تسجيل دخول');
    return { success: true, user: { ...user, permissions: perms } };
});

ipcMain.handle('create-user', async (event, data) => {
    const { company_id, full_name, username, password, role, currentUserId } = data;
    const hash = bcrypt.hashSync(password, 10);
    const result = await dbRun(
        "INSERT INTO users (company_id, full_name, username, password_hash, role) VALUES (?,?,?,?,?)",
        [company_id, full_name, username, hash, role]
    );
    const perms = {
        admin: { can_edit_products: 1, can_edit_prices: 1, can_edit_users: 1, can_view_reports: 1, can_close_shift: 1, can_refund: 1 },
        accountant: { can_edit_products: 0, can_edit_prices: 0, can_edit_users: 0, can_view_reports: 1, can_close_shift: 1, can_refund: 0 },
        cashier: { can_edit_products: 0, can_edit_prices: 0, can_edit_users: 0, can_view_reports: 0, can_close_shift: 0, can_refund: 0 }
    };
    const p = perms[role] || perms.cashier;
    await dbRun(
        "INSERT INTO permissions (user_id, can_edit_products, can_edit_prices, can_edit_users, can_view_reports, can_close_shift, can_refund) VALUES (?,?,?,?,?,?,?)",
        [result.lastInsertRowid, p.can_edit_products, p.can_edit_prices, p.can_edit_users, p.can_view_reports, p.can_close_shift, p.can_refund]
    );
    logAudit(currentUserId, 'create_user', `إنشاء مستخدم: ${username}`);
    return { success: true, id: result.lastInsertRowid };
});

ipcMain.handle('update-user', async (event, data) => {
    const { id, full_name, username, password, role, currentUserId } = data;
    const currentUser = await dbGet("SELECT role FROM users WHERE id=?", [currentUserId]);
    if (!currentUser || (currentUser.role !== 'admin' && currentUserId !== id)) {
        return { success: false, error: 'ليس لديك صلاحية لتعديل هذا المستخدم' };
    }
    if (password && password.length > 0) {
        const hash = bcrypt.hashSync(password, 10);
        await dbRun("UPDATE users SET full_name=?, username=?, password_hash=?, role=? WHERE id=?",
            [full_name, username, hash, role, id]);
    } else {
        await dbRun("UPDATE users SET full_name=?, username=?, role=? WHERE id=?",
            [full_name, username, role, id]);
    }
    logAudit(currentUserId, 'update_user', `تحديث بيانات المستخدم: ${username}`);
    return { success: true };
});

ipcMain.handle('toggle-block', async (event, { userId, currentUserId }) => {
    const user = await dbGet("SELECT is_blocked FROM users WHERE id=?", [userId]);
    if (!user) return { success: false, error: 'المستخدم غير موجود' };
    await dbRun("UPDATE users SET is_blocked=? WHERE id=?", [user.is_blocked ? 0 : 1, userId]);
    logAudit(currentUserId, 'toggle_block', `تغيير حالة الحظر للمستخدم #${userId}`);
    return { success: true };
});

// ========== بيانات الشركة والضريبة ==========
ipcMain.handle('get-company', async () => {
    return await dbGet("SELECT * FROM companies LIMIT 1");
});

ipcMain.handle('update-company', async (event, data) => {
    const { name, phone, address, tax_number, tax_rate, userId } = data;
    await dbRun("UPDATE companies SET name=?, phone=?, address=?, tax_number=?, tax_rate=? WHERE id=1",
        [name, phone, address, tax_number, tax_rate || 0]);
    logAudit(userId, 'update_company', 'تعديل بيانات المطعم');
    return { success: true };
});

ipcMain.handle('get-tax-rate', async () => {
    const row = await dbGet("SELECT tax_rate FROM companies WHERE id=1");
    return row ? row.tax_rate : 0;
});

// ========== الإعدادات ==========
ipcMain.handle('get-settings', async (event, companyId) => {
    const row = await dbGet("SELECT * FROM settings WHERE company_id=?", [companyId]);
    return row || {};
});

ipcMain.handle('save-settings', async (event, { companyId, settings, userId }) => {
    await dbRun("UPDATE settings SET safe_mode=?, pagination=?, profit_margin_percent=? WHERE company_id=?",
        [settings.safe_mode || 0, settings.pagination || 20, settings.profit_margin_percent || 30, companyId]);
    logAudit(userId, 'save_settings', 'تعديل الإعدادات');
    return { success: true };
});

// ========== المنتجات والأقسام ==========
ipcMain.handle('save-product', async (event, data) => {
    const { id, company_id, name, price, cost, category_id, barcode, recipe, unit, image, userId } = data;
    if (id) {
        await dbRun("UPDATE products SET name=?, price=?, category_id=?, cost=?, barcode=?, recipe=?, unit=?, image=? WHERE id=? AND company_id=?",
            [name, price, category_id, cost || 0, barcode, recipe, unit, image, id, company_id]);
        logAudit(userId, 'edit_product', `تعديل منتج: ${name}`);
        return { success: true, id };
    } else {
        const result = await dbRun(
            "INSERT INTO products (company_id, name, price, category_id, cost, barcode, recipe, unit, image) VALUES (?,?,?,?,?,?,?,?,?)",
            [company_id, name, price, category_id, cost || 0, barcode, recipe, unit, image]
        );
        logAudit(userId, 'add_product', `إضافة منتج: ${name}`);
        return { success: true, id: result.lastInsertRowid };
    }
});

ipcMain.handle('delete-product', async (event, { id, company_id, userId }) => {
    await dbRun("DELETE FROM products WHERE id=? AND company_id=?", [id, company_id]);
    logAudit(userId, 'delete_product', `حذف منتج #${id}`);
    return { success: true };
});

ipcMain.handle('save-category', async (event, { company_id, name, userId }) => {
    const result = await dbRun("INSERT INTO categories (company_id, name) VALUES (?,?)", [company_id, name]);
    logAudit(userId, 'add_category', `إضافة قسم: ${name}`);
    return { success: true, id: result.lastInsertRowid };
});

ipcMain.handle('delete-category', async (event, { id, userId }) => {
    await dbRun("DELETE FROM categories WHERE id=?", [id]);
    logAudit(userId, 'delete_category', `حذف قسم #${id}`);
    return { success: true };
});

// ========== المواد الخام ==========
ipcMain.handle('save-material', async (event, data) => {
    const { id, company_id, name, unit, min_stock, purchase_price } = data;
    if (id) {
        await dbRun("UPDATE raw_materials SET name=?, unit=?, min_stock=?, purchase_price=? WHERE id=? AND company_id=?",
            [name, unit, min_stock, purchase_price, id, company_id]);
        return { success: true, id };
    } else {
        const result = await dbRun(
            "INSERT INTO raw_materials (company_id, name, unit, min_stock, purchase_price) VALUES (?,?,?,?,?)",
            [company_id, name, unit, min_stock, purchase_price]
        );
        return { success: true, id: result.lastInsertRowid };
    }
});

ipcMain.handle('delete-material', async (event, { id, company_id }) => {
    await dbRun("DELETE FROM raw_materials WHERE id=? AND company_id=?", [id, company_id]);
    return { success: true };
});

// ========== المخزون ==========
ipcMain.handle('add-stock', async (event, { material_id, qty, userId }) => {
    await dbRun("UPDATE raw_materials SET current_stock = current_stock + ? WHERE id=?", [qty, material_id]);
    await dbRun(
        "INSERT INTO inventory_transactions (company_id, material_id, qty_change, type, reference, date, user_id) VALUES (?,?,?,?,?,?,?)",
        [1, material_id, qty, 'supply', 'توريد يدوي', new Date().toISOString().slice(0,10), userId]
    );
    logAudit(userId, 'add_stock', `توريد مادة #${material_id} بكمية ${qty}`);
    return { success: true };
});

// ========== الطلبات ==========
ipcMain.handle('create-order', async (event, data) => {
    const { company_id, table_id, waiter_id, user_id, total, tax, total_with_tax, discount, payment_method, paid_amount, order_type, shift_id, items } = data;
    const today = new Date().toISOString().slice(0,10);
    const time = new Date().toLocaleTimeString('ar-SA');
    const result = await dbRun(
        `INSERT INTO orders (company_id, table_id, waiter_id, user_id, total, tax, total_with_tax, discount, payment_method, paid_amount, order_type, date, time, shift_id)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [company_id, table_id, waiter_id, user_id, total, tax || 0, total_with_tax || total, discount || 0, payment_method, paid_amount, order_type || 'سفري', today, time, shift_id]
    );
    const orderId = result.lastInsertRowid;
    for (let item of items) {
        await dbRun("INSERT INTO order_items (order_id, product_id, qty, price) VALUES (?,?,?,?)",
            [orderId, item.id, item.qty, item.price]);
        if (item.recipe) {
            try {
                const recipe = JSON.parse(item.recipe);
                for (let comp of recipe) {
                    await dbRun("UPDATE raw_materials SET current_stock = current_stock - ? WHERE id=? AND company_id=?",
                        [comp.qty * item.qty, comp.material_id, company_id]);
                    await dbRun(
                        "INSERT INTO inventory_transactions (company_id, material_id, qty_change, type, reference, date, user_id) VALUES (?,?,?,?,?,?,?)",
                        [company_id, comp.material_id, -comp.qty * item.qty, 'consumption', `طلب #${orderId}`, today, user_id]
                    );
                }
            } catch(e) {}
        }
    }
    if (table_id) {
        await dbRun("UPDATE tables SET status='occupied' WHERE id=?", [table_id]);
    }
    logAudit(user_id, 'create_order', `طلب #${orderId} بقيمة ${total}`);
    return { success: true, orderId };
});

// ========== إرجاع الطلبات ==========
ipcMain.handle('refund-order', async (event, { orderId, userId, reason }) => {
    const order = await dbGet("SELECT * FROM orders WHERE id=?", [orderId]);
    if (!order) return { success: false, error: 'الطلب غير موجود' };
    if (order.status === 'refunded') return { success: false, error: 'الطلب مرتجع مسبقاً' };

    const items = await dbAll("SELECT * FROM order_items WHERE order_id=?", [orderId]);
    for (let item of items) {
        const product = await dbGet("SELECT * FROM products WHERE id=?", [item.product_id]);
        if (product && product.recipe) {
            try {
                const recipe = JSON.parse(product.recipe);
                for (let comp of recipe) {
                    await dbRun("UPDATE raw_materials SET current_stock = current_stock + ? WHERE id=?",
                        [comp.qty * item.qty, comp.material_id]);
                }
            } catch(e) {}
        }
    }
    await dbRun("UPDATE orders SET status='refunded' WHERE id=?", [orderId]);
    await dbRun("INSERT INTO refunds (order_id, user_id, amount, reason, date) VALUES (?,?,?,?,?)",
        [orderId, userId, order.total, reason, new Date().toISOString()]);
    logAudit(userId, 'refund_order', `إرجاع طلب #${orderId}`);
    return { success: true };
});

// ========== الورديات ==========
ipcMain.handle('open-shift', async (event, { company_id, user_id, opening_cash }) => {
    const today = new Date().toISOString().slice(0,10);
    const result = await dbRun(
        "INSERT INTO shifts (company_id, user_id, opening_cash, date, status) VALUES (?,?,?,?,?)",
        [company_id, user_id, opening_cash, today, 'open']
    );
    logAudit(user_id, 'open_shift', `فتح وردية #${result.lastInsertRowid}`);
    return { success: true, shiftId: result.lastInsertRowid };
});

ipcMain.handle('close-shift', async (event, { shiftId, actual_cash, userId }) => {
    const shift = await dbGet("SELECT * FROM shifts WHERE id=?", [shiftId]);
    if (!shift) return { success: false, error: 'الوردية غير موجودة' };
    if (shift.status !== 'open') return { success: false, error: 'الوردية مغلقة' };

    const totalSales = await dbGet("SELECT COALESCE(SUM(total),0) as total FROM orders WHERE shift_id=?", [shiftId]);
    const expected = shift.opening_cash + (totalSales ? totalSales.total : 0);
    const difference = actual_cash - expected;

    await dbRun("UPDATE shifts SET closing_cash=?, expected_cash=?, cash_difference=?, status='closed', closed_at=CURRENT_TIMESTAMP WHERE id=?",
        [actual_cash, expected, difference, shiftId]);
    backupDatabase();
    logAudit(userId, 'close_shift', `إغلاق وردية #${shiftId}، الفارق: ${difference}`);
    return { success: true, expected, difference };
});

// ========== المصروفات ==========
ipcMain.handle('add-expense', async (event, data) => {
    const { company_id, month, category, description, amount, type, user_id } = data;
    await dbRun(
        "INSERT INTO expenses (company_id, month, category, description, amount, type, date, user_id) VALUES (?,?,?,?,?,?,?,?)",
        [company_id, month, category, description, amount, type, new Date().toISOString().slice(0,10), user_id]
    );
    logAudit(user_id, 'add_expense', `إضافة مصروف: ${description} بقيمة ${amount}`);
    return { success: true };
});

ipcMain.handle('delete-expense', async (event, { id, userId }) => {
    await dbRun("DELETE FROM expenses WHERE id=?", [id]);
    logAudit(userId, 'delete_expense', `حذف مصروف #${id}`);
    return { success: true };
});

// ========== التقارير ==========
ipcMain.handle('get-sales-report', async (event, { startDate, endDate, companyId }) => {
    return await dbAll(
        `SELECT date, COUNT(*) as count, SUM(total) as total, SUM(tax) as tax, SUM(total_with_tax) as total_with_tax,
         payment_method, SUM(paid_amount) as paid
         FROM orders WHERE company_id=? AND date BETWEEN ? AND ? AND status='completed'
         GROUP BY date, payment_method ORDER BY date`,
        [companyId, startDate, endDate]
    );
});

ipcMain.handle('get-profit-report', async (event, { startDate, endDate, companyId }) => {
    const orders = await dbAll(
        `SELECT o.id, o.total, oi.product_id, oi.qty, p.cost
         FROM orders o
         JOIN order_items oi ON o.id = oi.order_id
         JOIN products p ON oi.product_id = p.id
         WHERE o.company_id=? AND o.date BETWEEN ? AND ? AND o.status='completed'`,
        [companyId, startDate, endDate]
    );
    let totalCost = 0;
    for (let row of orders) {
        totalCost += (row.cost || 0) * row.qty;
    }
    const totalSales = orders.reduce((sum, o) => sum + o.total, 0);
    const profit = totalSales - totalCost;
    return { totalSales, totalCost, profit };
});

ipcMain.handle('get-expense-report', async (event, { startDate, endDate, companyId }) => {
    return await dbAll(
        "SELECT category, SUM(amount) as total FROM expenses WHERE company_id=? AND date BETWEEN ? AND ? GROUP BY category",
        [companyId, startDate, endDate]
    );
});

ipcMain.handle('get-inventory-report', async (event, { companyId }) => {
    return await dbAll("SELECT * FROM raw_materials WHERE company_id=?", [companyId]);
});

// ========== الطباعة ==========
ipcMain.handle('print-thermal', async (event, { html, userId }) => {
    try {
        const printer = new ThermalPrinter({
            type: PrinterTypes.EPSON,
            interface: 'USB',
            options: { timeout: 5000 }
        });
        await printer.connect();
        await printer.print(html);
        await printer.disconnect();
        logAudit(userId, 'print_receipt', 'طباعة فاتورة حرارية');
        return { success: true, method: 'thermal' };
    } catch (e) {
        console.warn('فشلت الطباعة الحرارية، استخدام نافذة المتصفح:', e.message);
        if (mainWindow) {
            mainWindow.webContents.send('fallback-print', html);
        }
        return { success: true, method: 'fallback' };
    }
});

// ========== الصور ==========
ipcMain.handle('save-product-image', async (event, { fileName, buffer }) => {
    try {
        const filePath = path.join(imagesDir, fileName);
        fs.writeFileSync(filePath, Buffer.from(buffer));
        return { success: true, imagePath: `product-images/${fileName}` };
    } catch (e) {
        return { success: false, error: e.message };
    }
});

ipcMain.handle('get-product-image', (event, imagePath) => {
    try {
        if (!imagePath) return { success: false };
        const fullPath = path.join(app.getPath('userData'), imagePath);
        if (fs.existsSync(fullPath)) {
            const buffer = fs.readFileSync(fullPath);
            return { success: true, buffer: buffer.toString('base64') };
        }
        return { success: false };
    } catch (e) {
        return { success: false };
    }
});

// ========== نسخ احتياطي ==========
ipcMain.handle('manual-backup', async () => {
    return backupDatabase();
});

// ========== الطاولات والكباتن ==========
ipcMain.handle('save-table', async (event, { company_id, name }) => {
    await dbRun("INSERT INTO tables (company_id, name) VALUES (?,?)", [company_id, name]);
    return { success: true };
});

ipcMain.handle('delete-table', async (event, { id }) => {
    await dbRun("DELETE FROM tables WHERE id=?", [id]);
    return { success: true };
});

ipcMain.handle('save-waiter', async (event, { company_id, name }) => {
    await dbRun("INSERT INTO waiters (company_id, name) VALUES (?,?)", [company_id, name]);
    return { success: true };
});

ipcMain.handle('delete-waiter', async (event, { id }) => {
    await dbRun("DELETE FROM waiters WHERE id=?", [id]);
    return { success: true };
});

// ========== تصدير PDF ==========
ipcMain.handle('export-pdf', async (event, { content, title, userId }) => {
    const doc = {
        content: content,
        defaultStyle: { font: 'Tajawal' }
    };
    const pdfDoc = pdfMake.createPdf(doc);
    const filePath = path.join(app.getPath('documents'), `${title}_${Date.now()}.pdf`);
    return new Promise((resolve) => {
        pdfDoc.getBuffer((buffer) => {
            fs.writeFile(filePath, buffer, (err) => {
                if (err) resolve({ success: false, error: err.message });
                else {
                    logAudit(userId, 'export_pdf', `تصدير تقرير: ${title}`);
                    resolve({ success: true, path: filePath });
                }
            });
        });
    });
});

// ========== سجل التدقيق ==========
ipcMain.handle('get-audit-log', async (event, { limit = 100 }) => {
    return await dbAll("SELECT * FROM audit_log ORDER BY date DESC LIMIT ?", [limit]);
});

// ========== مسار بيانات المستخدم ==========
ipcMain.handle('get-user-data-path', () => {
    return app.getPath('userData');
});

console.log('✅ نظام تقنيات سوفت المطور جاهز (better-sqlite3)');
