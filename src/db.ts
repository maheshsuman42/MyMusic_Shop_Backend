import mongoose from 'mongoose';
import bcrypt from 'bcryptjs';

const MONGODB_URI = process.env.MONGODB_URI || 'mongodb+srv://ms4270436_db_user:root@cluster0.n09mwi6.mongodb.net/?appName=Cluster0';

export async function initDb() {
  try {
    await mongoose.connect(MONGODB_URI);
    console.log('Connected to MongoDB');
    
    // Seed admin if not present
    const User = mongoose.model('User');
    const adminEmail = process.env.ADMIN_EMAIL || 'admin@vibrato.com';
    const hasAdmin = await User.findOne({ email: adminEmail });
    if (!hasAdmin) {
      const hashedPassword = bcrypt.hashSync(process.env.ADMIN_PASSWORD || 'vibrato123', 10);
      await User.create({
        name: 'Admin',
        email: adminEmail,
        password: hashedPassword,
        role: 'admin'
      });
      console.log('Seed: Admin user created.');
    }

    // Seed sample products if empty
    const Product = mongoose.model('Product');
    const productCount = await Product.countDocuments();
    if (productCount === 0) {
      await seedSampleData(Product);
    }
  } catch (error) {
    console.error('MongoDB connection error:', error);
  }
}

async function seedSampleData(Product: any) {
  const samples = [
    { name: 'Gibson Les Paul Standard', description: 'Classic rock icon with rich humbucking tones.', price: 2499, category: 'Guitar', stock: 5, images: [{ url: 'https://picsum.photos/seed/Gibson/800/600' }] },
    { name: 'Fender Stratocaster Elite', description: 'Versatile electric guitar for ultimate playability.', price: 1899, category: 'Guitar', stock: 8, images: [{ url: 'https://picsum.photos/seed/Fender/800/600' }] },
    { name: 'Yamaha P-125 Digital Piano', description: 'Authentic piano performance in a compact design.', price: 699, category: 'Piano', stock: 12, images: [{ url: 'https://picsum.photos/seed/Yamaha/800/600' }] },
    { name: 'Roland V-Drums TD-17KVX', description: 'Become a better drummer faster with professional kits.', price: 1599, category: 'Drums', stock: 3, images: [{ url: 'https://picsum.photos/seed/Roland/800/600' }] },
    { name: 'Ernie Ball Slinky Strings', description: 'The world\'s #1 electric guitar strings.', price: 7.99, category: 'Accessories', stock: 100, images: [{ url: 'https://picsum.photos/seed/ErnieBall/800/600' }] },
    { name: 'Korg Kronos 2', description: 'Ultimate music workstation with 9 sound engines.', price: 3499, category: 'Keyboard', stock: 2, images: [{ url: 'https://picsum.photos/seed/Korg/800/600' }] },
    { name: 'Yamaha YFL-222 Flute', description: 'Beginner student flute with offset G and C footjoint.', price: 499, category: 'Flute', stock: 15, images: [{ url: 'https://picsum.photos/seed/Flute/800/600' }] },
  ];
  await Product.insertMany(samples);
  console.log('Seed: Sample products created.');
}

// Model Definitions
const userSchema = new mongoose.Schema({
  name: { type: String, required: true },
  email: { type: String, required: true, unique: true },
  password: { type: String, required: true },
  phone: { type: String },
  role: { type: String, default: 'user' },
  avatar: { type: String },
  addresses: [{
    label: { type: String, default: 'Home' },
    street: { type: String, required: true },
    city: { type: String, required: true },
    state: { type: String, required: true },
    zip: { type: String, required: true },
    phone: { type: String, required: true }
  }],
  createdAt: { type: Date, default: Date.now }
});
mongoose.model('User', userSchema);

const productSchema = new mongoose.Schema({
  name: { type: String, required: true },
  description: { type: String },
  price: { type: Number, required: true },
  discount: { type: Number, default: 0 },
  category: { type: String, required: true },
  stock: { type: Number, default: 0 },
  images: [{
    url: { type: String, required: true },
    public_id: { type: String }
  }],
  rating: { type: Number, default: 0 },
  numReviews: { type: Number, default: 0 },
  createdAt: { type: Date, default: Date.now }
});
mongoose.model('Product', productSchema);

const reviewSchema = new mongoose.Schema({
  product: { type: mongoose.Schema.Types.ObjectId, ref: 'Product', required: true },
  user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  name: { type: String, required: true },
  rating: { type: Number, required: true, min: 1, max: 5 },
  comment: { type: String, required: true },
  createdAt: { type: Date, default: Date.now }
});
mongoose.model('Review', reviewSchema);

const orderSchema = new mongoose.Schema({
  user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  items: [{
    product: { type: mongoose.Schema.Types.ObjectId, ref: 'Product', required: true },
    quantity: { type: Number, required: true },
    price: { type: Number, required: true }
  }],
  totalAmount: { type: Number, required: true },
  status: { type: String, default: 'pending' },
  paymentMethod: { type: String, enum: ['razorpay', 'cod'], default: 'razorpay' },
  address: { type: String, required: true },
  paymentId: { type: String },
  razorpayOrderId: { type: String },
  createdAt: { type: Date, default: Date.now }
});
mongoose.model('Order', orderSchema);

const supportTicketSchema = new mongoose.Schema({
  user: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  name: { type: String, required: true },
  email: { type: String, required: true },
  phone: { type: String },
  subject: { type: String, required: true },
  message: { type: String, required: true },
  status: { type: String, enum: ['open', 'closed'], default: 'open' },
  createdAt: { type: Date, default: Date.now }
});
mongoose.model('SupportTicket', supportTicketSchema);

export default mongoose;
