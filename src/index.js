import express from 'express';
import cors from 'cors';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import mongoose, { initDb } from './db.js';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import Razorpay from 'razorpay';
import crypto from 'crypto';
import multer from 'multer';
import { sendTelegramAlert, formatNewOrderAlert, formatLowStockAlert } from './telegram.js';
import dotenv from 'dotenv';
dotenv.config();
// Fix __dirname for ES modules
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
// Initialize Database & Start Server
async function startServer() {
    const app = express();
    const PORT = process.env.PORT || 5000;
    app.use(cors()); // Allow all cross-origin requests
    app.use(express.json());
    // Health Check early
    app.get('/api/health', (req, res) => res.json({ status: 'ok', timestamp: new Date() }));
    // --- Multer Setup ---
    const uploadDir = 'uploads';
    if (!fs.existsSync(uploadDir)) {
        fs.mkdirSync(uploadDir);
    }
    const storage = multer.diskStorage({
        destination: (req, file, cb) => cb(null, uploadDir),
        filename: (req, file, cb) => {
            const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
            cb(null, uniqueSuffix + path.extname(file.originalname));
        }
    });
    const upload = multer({
        storage,
        limits: { fileSize: 10 * 1024 * 1024 }, // Increase to 10MB
    });
    app.use('/uploads', express.static(uploadDir));
    // --- Razorpay Config ---
    const razorpay = new Razorpay({
        key_id: process.env.RAZORPAY_KEY_ID,
        key_secret: process.env.RAZORPAY_KEY_SECRET,
    });
    // --- Auth Middleware ---
    const authenticate = (req, res, next) => {
        const token = req.headers.authorization?.split(' ')[1];
        if (!token)
            return res.status(401).json({ error: 'Unauthorized' });
        try {
            const decoded = jwt.verify(token, process.env.JWT_SECRET || 'secret');
            req.user = decoded;
            next();
        }
        catch (err) {
            res.status(403).json({ error: 'Forbidden' });
        }
    };
    const adminOnly = (req, res, next) => {
        if (req.user?.role !== 'admin')
            return res.status(403).json({ error: 'Admin access required' });
        next();
    };
    // --- Models ---
    const User = mongoose.model('User');
    const Product = mongoose.model('Product');
    const Order = mongoose.model('Order');
    const SupportTicket = mongoose.model('SupportTicket');
    const Review = mongoose.model('Review');
    // --- Async Handler Wrapper ---
    const asyncHandler = (fn) => (req, res, next) => {
        Promise.resolve(fn(req, res, next)).catch(err => {
            console.error('Async Error:', err);
            res.status(500).json({ error: 'Internal Server Error', details: err instanceof Error ? err.message : String(err) });
        });
    };
    // --- API Routes ---
    // Auth
    app.post('/api/auth/register', asyncHandler(async (req, res) => {
        const { name, email, password } = req.body;
        const hash = bcrypt.hashSync(password, 10);
        try {
            const user = await User.create({ name, email, password: hash });
            const userObj = { id: user._id, name, email, role: 'user' };
            const token = jwt.sign(userObj, process.env.JWT_SECRET || 'secret');
            res.json({ user: userObj, token });
        }
        catch (err) {
            res.status(400).json({ error: 'Email already exists' });
        }
    }));
    app.post('/api/auth/login', asyncHandler(async (req, res) => {
        const { email, password } = req.body;
        const user = await User.findOne({ email });
        if (!user || !bcrypt.compareSync(password, user.password)) {
            return res.status(401).json({ error: 'Invalid credentials' });
        }
        const userObj = { id: user._id, name: user.name, email: user.email, role: user.role };
        const token = jwt.sign(userObj, process.env.JWT_SECRET || 'secret');
        res.json({ user: userObj, token });
    }));
    // Products
    app.get('/api/products', asyncHandler(async (req, res) => {
        const products = await Product.find().lean();
        const formatted = products.map((p) => ({ ...p, id: p._id.toString() }));
        res.json(formatted);
    }));
    app.get('/api/products/:id', asyncHandler(async (req, res) => {
        const product = await Product.findById(req.params.id).lean();
        if (!product)
            return res.status(404).json({ error: 'Product not found' });
        res.json({ ...product, id: product._id.toString() });
    }));
    // Admin: Add Product
    app.post('/api/admin/products', authenticate, adminOnly, asyncHandler(async (req, res) => {
        const { name, description, price, category, stock, images } = req.body;
        const productImages = (images || []).map((url) => ({ url }));
        const product = await Product.create({
            name, description, price, category, stock, images: productImages
        });
        res.json({ id: product._id, message: 'Product created' });
    }));
    app.put('/api/admin/products/:id', authenticate, adminOnly, asyncHandler(async (req, res) => {
        const { name, description, price, category, stock, images } = req.body;
        const productImages = (images || []).map((url) => ({ url }));
        const product = await Product.findByIdAndUpdate(req.params.id, {
            name, description, price, category, stock, images: productImages
        }, { new: true });
        if (!product)
            return res.status(404).json({ error: 'Product not found' });
        // Admin manually updated stock - check if low
        if (product.stock <= 50) {
            sendTelegramAlert(formatLowStockAlert(product)).catch(console.error);
        }
        res.json({ message: 'Product updated' });
    }));
    app.delete('/api/admin/products/:id', authenticate, adminOnly, asyncHandler(async (req, res) => {
        const product = await Product.findByIdAndDelete(req.params.id);
        if (!product)
            return res.status(404).json({ error: 'Product not found' });
        res.json({ message: 'Product deleted' });
    }));
    // Stats
    app.get('/api/admin/stats', authenticate, adminOnly, asyncHandler(async (req, res) => {
        const totalRevenue = await Order.aggregate([
            { $match: { status: { $ne: 'cancelled' } } },
            { $group: { _id: null, total: { $sum: '$totalAmount' } } }
        ]);
        const ordersCount = await Order.countDocuments();
        const customersCount = await User.countDocuments({ role: 'user' });
        const productCount = await Product.countDocuments();
        const ticketsCount = await SupportTicket.countDocuments({ status: 'open' });
        res.json({
            revenue: totalRevenue[0]?.total || 0,
            orders: ordersCount,
            customers: customersCount,
            inventory: productCount,
            tickets: ticketsCount
        });
    }));
    // Admin: Get all orders
    app.get('/api/admin/orders', authenticate, adminOnly, asyncHandler(async (req, res) => {
        const orders = await Order.find()
            .populate('user', 'name email')
            .populate('items.product', 'name')
            .sort({ createdAt: -1 })
            .lean();
        const formatted = orders.map((o) => ({
            ...o,
            id: o._id.toString(),
            userName: o.user?.name || 'Deleted User',
            items_summary: o.items.map((i) => `${i.product?.name || 'Instrument'} (x${i.quantity})`).join(', ')
        }));
        res.json(formatted);
    }));
    // Admin: Update order status
    app.put('/api/admin/orders/:id/status', authenticate, adminOnly, asyncHandler(async (req, res) => {
        const { status } = req.body;
        const order = await Order.findByIdAndUpdate(req.params.id, { status }, { new: true });
        if (!order)
            return res.status(404).json({ error: 'Order not found' });
        res.json(order);
    }));
    // Admin: Get all users
    app.get('/api/admin/users', authenticate, adminOnly, asyncHandler(async (req, res) => {
        const users = await User.find({}, '-password').sort({ createdAt: -1 }).lean();
        const formatted = users.map((u) => ({ ...u, id: u._id.toString() }));
        res.json(formatted);
    }));
    // Admin: Update user role
    app.put('/api/admin/users/:id/role', authenticate, adminOnly, asyncHandler(async (req, res) => {
        const { role } = req.body;
        if (!['user', 'admin'].includes(role)) {
            return res.status(400).json({ error: 'Invalid role' });
        }
        // Prevent self-demotion
        if (req.params.id === req.user.id && role !== 'admin') {
            return res.status(400).json({ error: 'Cannot demote yourself' });
        }
        const updatedUser = await User.findByIdAndUpdate(req.params.id, { role }, { new: true }).select('-password').lean();
        if (!updatedUser)
            return res.status(404).json({ error: 'User not found' });
        res.json({ user: { ...updatedUser, id: updatedUser._id.toString() }, message: 'User role updated' });
    }));
    // Support Tickets
    app.post('/api/support', asyncHandler(async (req, res) => {
        const { name, email, phone, subject, message } = req.body;
        if (phone && phone.replace(/\D/g, '').length !== 10) {
            return res.status(400).json({ error: 'Valid 10-digit phone number is required' });
        }
        const ticket = await SupportTicket.create({ name, email, phone, subject, message });
        res.json({ id: ticket._id, message: 'Ticket created' });
    }));
    app.get('/api/admin/support', authenticate, adminOnly, asyncHandler(async (req, res) => {
        const tickets = await SupportTicket.find().sort({ createdAt: -1 }).lean();
        res.json(tickets.map((t) => ({ ...t, id: t._id.toString() })));
    }));
    app.put('/api/admin/support/:id/status', authenticate, adminOnly, asyncHandler(async (req, res) => {
        const { status } = req.body;
        await SupportTicket.findByIdAndUpdate(req.params.id, { status });
        res.json({ message: 'Status updated' });
    }));
    app.delete('/api/admin/support/:id', authenticate, adminOnly, asyncHandler(async (req, res) => {
        const ticket = await SupportTicket.findByIdAndDelete(req.params.id);
        if (!ticket)
            return res.status(404).json({ error: 'Ticket not found' });
        res.json({ message: 'Ticket deleted' });
    }));
    // User: Settings & Addresses
    app.get('/api/user/profile', authenticate, asyncHandler(async (req, res) => {
        const user = await User.findById(req.user.id, '-password').lean();
        res.json({ ...user, id: user._id.toString() });
    }));
    app.put('/api/user/profile', authenticate, asyncHandler(async (req, res) => {
        const { name, email, phone, avatar } = req.body;
        if (phone && phone.replace(/\D/g, '').length !== 10) {
            return res.status(400).json({ error: 'Valid 10-digit phone number is required' });
        }
        const update = {};
        if (name)
            update.name = name;
        if (email)
            update.email = email;
        if (phone !== undefined)
            update.phone = phone;
        if (avatar !== undefined)
            update.avatar = avatar;
        const user = await User.findByIdAndUpdate(req.user.id, update, { new: true }).select('-password').lean();
        res.json({ user: { ...user, id: user._id.toString() }, message: 'Profile updated' });
    }));
    app.delete('/api/user/profile', authenticate, asyncHandler(async (req, res) => {
        const user = await User.findByIdAndDelete(req.user.id);
        if (!user)
            return res.status(404).json({ error: 'User not found' });
        res.json({ message: 'Account deleted successfully' });
    }));
    app.put('/api/user/password', authenticate, asyncHandler(async (req, res) => {
        const { currentPassword, newPassword } = req.body;
        const user = await User.findById(req.user.id);
        if (!bcrypt.compareSync(currentPassword, user.password)) {
            return res.status(401).json({ error: 'Invalid current password' });
        }
        user.password = bcrypt.hashSync(newPassword, 10);
        await user.save();
        res.json({ message: 'Password updated' });
    }));
    app.post('/api/user/addresses', authenticate, asyncHandler(async (req, res) => {
        const { phone } = req.body;
        if (!phone || phone.replace(/\D/g, '').length !== 10) {
            return res.status(400).json({ error: 'Valid 10-digit phone number is required' });
        }
        const user = await User.findById(req.user.id);
        if (!user)
            return res.status(404).json({ error: 'User not found' });
        user.addresses.push(req.body);
        await user.save();
        res.json(user.addresses);
    }));
    app.delete('/api/user/addresses/:idx', authenticate, asyncHandler(async (req, res) => {
        const user = await User.findById(req.user.id);
        if (!user)
            return res.status(404).json({ error: 'User not found' });
        user.addresses.splice(parseInt(req.params.idx), 1);
        await user.save();
        res.json(user.addresses);
    }));
    // --- Reviews ---
    app.get('/api/products/:id/reviews', asyncHandler(async (req, res) => {
        const reviews = await Review.find({ product: req.params.id }).sort({ createdAt: -1 }).lean();
        res.json(reviews.map((r) => ({ ...r, id: r._id.toString() })));
    }));
    app.post('/api/products/:id/reviews', authenticate, asyncHandler(async (req, res) => {
        const { rating, comment } = req.body;
        const productId = req.params.id;
        const alreadyReviewed = await Review.findOne({ product: productId, user: req.user.id });
        if (alreadyReviewed) {
            return res.status(400).json({ error: 'Product already reviewed' });
        }
        await Review.create({
            product: productId,
            user: req.user.id,
            name: req.user.name,
            rating: Number(rating),
            comment
        });
        const reviews = await Review.find({ product: productId });
        const numReviews = reviews.length;
        const avgRating = reviews.reduce((acc, item) => item.rating + acc, 0) / numReviews;
        await Product.findByIdAndUpdate(productId, {
            rating: avgRating,
            numReviews: numReviews
        });
        res.status(201).json({ message: 'Review added' });
    }));
    // Checkout: Create Razorpay Order
    app.post('/api/checkout/create-razorpay-order', authenticate, asyncHandler(async (req, res) => {
        const { amount } = req.body;
        console.log(`Creating Razorpay order for amount: ${amount}`);
        if (amount <= 0) {
            return res.status(400).json({ error: 'Invalid order amount' });
        }
        const options = {
            amount: Math.round(amount * 100), // in paise
            currency: 'INR',
            receipt: `receipt_${Date.now()}`,
        };
        try {
            const order = await razorpay.orders.create(options);
            return res.json(order);
        }
        catch (err) {
            console.error('Razorpay Order Error:', err);
            res.status(500).json({
                error: 'Razorpay order creation failed',
                details: err.message
            });
        }
    }));
    // Orders: Verify Payment and Create Order
    app.post('/api/orders', authenticate, asyncHandler(async (req, res) => {
        const { items, totalAmount, address, paymentMethod, razorpayOrderId, razorpayPaymentId, razorpaySignature } = req.body;
        // For online payments, verify signature
        if (paymentMethod === 'razorpay') {
            const body = razorpayOrderId + '|' + razorpayPaymentId;
            const expectedSignature = crypto
                .createHmac('sha256', process.env.RAZORPAY_KEY_SECRET)
                .update(body.toString())
                .digest('hex');
            if (expectedSignature !== razorpaySignature) {
                return res.status(400).json({ error: 'Invalid signature' });
            }
        }
        const orderData = {
            user: req.user.id,
            items: items.map((i) => ({ product: i.productId, quantity: i.quantity, price: i.price })),
            totalAmount,
            address,
            paymentMethod,
            status: paymentMethod === 'razorpay' ? 'confirmed' : 'pending'
        };
        if (paymentMethod === 'razorpay') {
            orderData.razorpayOrderId = razorpayOrderId;
            orderData.paymentId = razorpayPaymentId;
        }
        const order = await Order.create(orderData);
        // Update stock and send notifications
        try {
            const itemsWithDetails = [];
            for (const item of items) {
                const product = await Product.findByIdAndUpdate(item.productId, { $inc: { stock: -item.quantity } }, { new: true });
                if (product) {
                    itemsWithDetails.push({ ...item, productName: product.name });
                    // Check for low stock (threshold: 50)
                    if (product.stock <= 50) {
                        await sendTelegramAlert(formatLowStockAlert(product));
                    }
                }
            }
            // Send New Order Alert
            const orderWithNames = { ...order.toObject(), items: itemsWithDetails };
            await sendTelegramAlert(formatNewOrderAlert(orderWithNames, req.user.name));
        }
        catch (notifErr) {
            console.error('Notification/Stock Update Error:', notifErr);
        }
        res.json({ id: order._id, message: 'Order placed' });
    }));
    app.get('/api/orders/my', authenticate, asyncHandler(async (req, res) => {
        const orders = await Order.find({ user: req.user.id })
            .populate('items.product', 'name')
            .sort({ createdAt: -1 })
            .lean();
        const formatted = orders.map((o) => ({
            ...o,
            id: o._id.toString(),
            items_summary: o.items.map((i) => `${i.product?.name || 'Instrument'} (x${i.quantity})`).join(', ')
        }));
        res.json(formatted);
    }));
    // Upload endpoint
    app.post('/api/upload', authenticate, upload.single('image'), (req, res) => {
        if (!req.file)
            return res.status(400).json({ error: 'No file uploaded' });
        const url = `http://localhost:${PORT}/uploads/${req.file.filename}`;
        res.json({ url });
    });
    // API 404 Catch-all
    app.use('/api', (req, res) => {
        res.status(404).json({ error: `API route not found: ${req.method} ${req.url}` });
    });
    // Global Error Handler for API
    app.use((err, req, res, next) => {
        if (err instanceof multer.MulterError) {
            if (err.code === 'LIMIT_FILE_SIZE') {
                return res.status(400).json({ error: 'File is too large. Max limit is 10MB.' });
            }
            return res.status(400).json({ error: `Upload error: ${err.message}` });
        }
        if (err) {
            console.error('Server Error:', err);
            return res.status(500).json({ error: 'Internal Server Error', details: err.message });
        }
        next(err);
    });
    app.listen(PORT, '0.0.0.0', () => {
        console.log(`Server running on http://localhost:${PORT}`);
        // Initialize DB after starting listener to avoid blocking startup
        initDb().catch(err => console.error('Delayed DB Init Error:', err));
    });
}
// Global Rejection Handler
process.on('unhandledRejection', (reason) => {
    console.error('Unhandled Rejection at:', reason instanceof Error ? reason : JSON.stringify(reason));
});
startServer().catch(err => {
    console.error('Failed to start server:', err);
});
