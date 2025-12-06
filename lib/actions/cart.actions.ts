"use server";

import { cookies } from "next/headers";
import { auth } from "@/auth";
import { prisma } from "@/db/prisma";
import { cartItemSchema, insertCartSchema } from "../validators";
import { CartItem } from "@/types";
import { convertToPlainObject, round2, formatError } from "../utils";
import { Prisma } from "@prisma/client";
import { revalidatePath } from "next/cache";

const calcPrice = (items: CartItem[]) => {
  const itemsPrice = round2(
      items.reduce((acc, item) => acc + Number(item.price) * item.qty, 0)
    ),
    shippingPrice = round2(itemsPrice > 100 ? 0 : 10),
    taxPrice = round2(0.15 * itemsPrice),
    totalPrice = round2(itemsPrice + shippingPrice + taxPrice);
  return {
    itemsPrice: itemsPrice.toFixed(2),
    shippingPrice: shippingPrice.toFixed(2),
    taxPrice: taxPrice.toFixed(2),
    totalPrice: totalPrice.toFixed(2),
  };
};

export async function addItemToCart(data: CartItem) {
  try {
    // 1️⃣ Get session info
    const cookieStore = await cookies();
    const sessionCartId = cookieStore.get("sessionCartId")?.value;
    const session = await auth();
    const user = session?.user ?? null;
    const userId = session?.user?.id ?? null;

    const item = cartItemSchema.parse(data);
    const product = await prisma.product.findFirst({
      where: { id: item.productId },
    });
    if (!product) throw new Error("Product not found");

    console.log("User:", user);
    console.log("UserId:", userId);

    // 2️⃣ Fetch existing carts
    const userCart = userId
      ? await prisma.cart.findFirst({ where: { userId } })
      : null;

    const sessionCart = sessionCartId
      ? await prisma.cart.findFirst({ where: { sessionCartId } })
      : null;

    let cartToUse;

    // 3️⃣ Determine which cart to use
    if (userId) {
      if (userCart) {
        cartToUse = userCart;
      } else if (sessionCart && !sessionCart.userId) {
        // Merge guest cart into user cart (only if session cart is not linked)
        cartToUse = await prisma.cart.update({
          where: { id: sessionCart.id },
          data: { userId },
        });
      } else {
        // No cart exists → create new user cart
        const newCart = insertCartSchema.parse({
          userId,
          items: [item],
          ...calcPrice([item]),
        });
        cartToUse = await prisma.cart.create({ data: newCart });
      }
    } else {
      // Guest user
      if (sessionCart) {
        cartToUse = sessionCart;
      } else if (sessionCartId) {
        const newCart = insertCartSchema.parse({
          sessionCartId,
          items: [item],
          ...calcPrice([item]),
        });
        cartToUse = await prisma.cart.create({ data: newCart });
      } else {
        throw new Error("No session cart available");
      }
    }

    // 4️⃣ Add or update item in cart
    const existItem = (cartToUse.items as CartItem[]).find(
      (x) => x.productId === item.productId
    );
    if (existItem) {
      if (product.stock < existItem.qty + 1)
        throw new Error("Not enough stock");
      existItem.qty += 1;
    } else {
      if (product.stock < 1) throw new Error("Not enough stock");
      cartToUse.items.push(item);
    }

    // 5️⃣ Update cart totals
    await prisma.cart.update({
      where: { id: cartToUse.id },
      data: {
        items: cartToUse.items as Prisma.CartUpdateitemsInput[],
        ...calcPrice(cartToUse.items as CartItem[]),
      },
    });

    return {
      success: true,
      message: `${product.name} added to cart successfully`,
    };
  } catch (error) {
    return { success: false, message: formatError(error) };
  }
}

export async function addItemToCartOriginal(data: CartItem) {
  try {
    // Check for session cart cookie
    const sessionCartId = (await cookies()).get("sessionCartId")?.value;
    if (!sessionCartId) throw new Error("Cart Session not found");

    // Get session and user ID
    const session = await auth();
    const userId = session?.user?.id ? (session.user.id as string) : undefined;

    // Get cart from database
    const cart = await getMyCart();

    // Parse and validate submitted item data
    const item = cartItemSchema.parse(data);
    // Find product in database
    const product = await prisma.product.findFirst({
      where: { id: item.productId },
    });
    if (!product) throw new Error("Product not found");

    if (!cart) {
      // Create new cart object
      const newCart = insertCartSchema.parse({
        userId: userId,
        items: [item],
        sessionCartId: sessionCartId,
        ...calcPrice([item]),
      });
      // Add to database
      await prisma.cart.create({
        data: newCart,
      });

      // Revalidate product page
      revalidatePath(`/product/${product.slug}`);

      return {
        success: true,
        message: "Item added to cart successfully",
      };
    } else {
      // Check for existing item in cart
      const existItem = (cart.items as CartItem[]).find(
        (x) => x.productId === item.productId
      );
      // If not enough stock, throw error
      if (existItem) {
        if (product.stock < existItem.qty + 1) {
          throw new Error("Not enough stock");
        }

        // Increase quantity of existing item
        (cart.items as CartItem[]).find(
          (x) => x.productId === item.productId
        )!.qty = existItem.qty + 1;
      } else {
        // If stock, add item to cart
        if (product.stock < 1) throw new Error("Not enough stock");
        cart.items.push(item);
      }

      // Save to database
      await prisma.cart.update({
        where: { id: cart.id },
        data: {
          items: cart.items as Prisma.CartUpdateitemsInput[],
          ...calcPrice(cart.items as CartItem[]),
        },
      });

      revalidatePath(`/product/${product.slug}`);

      return {
        success: true,
        message: `${product.name} ${
          existItem ? "updated in" : "added to"
        } cart successfully`,
      };
    }
  } catch (error) {
    return { success: false, message: formatError(error) };
  }
}

export async function getMyCart() {
  try {
    const cookieStore = await cookies();
    const sessionCartId = cookieStore.get("sessionCartId")?.value;

    const session = await auth();
    const userId = session?.user?.id ?? null;

    // 1️⃣ Fetch existing carts
    const userCart = userId
      ? await prisma.cart.findFirst({ where: { userId } })
      : null;

    const sessionCart = sessionCartId
      ? await prisma.cart.findFirst({ where: { sessionCartId } })
      : null;

    let cart;

    if (userId) {
      if (userCart) {
        cart = userCart;
      } else if (sessionCart && !sessionCart.userId) {
        // Merge guest cart into user
        cart = await prisma.cart.update({
          where: { id: sessionCart.id },
          data: { userId },
        });
      } else {
        // No cart exists for user
        return undefined;
      }
    } else {
      // Guest user
      if (sessionCart) {
        cart = sessionCart;
      } else {
        return undefined;
      }
    }

    // Convert Decimal fields to strings for client
    return convertToPlainObject({
      ...cart,
      items: cart.items as CartItem[],
      itemsPrice: cart.itemsPrice.toString(),
      totalPrice: cart.totalPrice.toString(),
      shippingPrice: cart.shippingPrice.toString(),
      taxPrice: cart.taxPrice.toString(),
    });
  } catch (error) {
    console.error("getMyCart error:", error);
    return undefined;
  }
}

//  Get user cart from database
export async function getMyCartOriginal() {
  // Check for session cart cookie
  const sessionCartId = (await cookies()).get("sessionCartId")?.value;
  if (!sessionCartId) return undefined;

  // Get session and user ID
  const session = await auth();
  const userId = session?.user?.id;

  // Get user cart from database
  const cart = await prisma.cart.findFirst({
    where: userId ? { userId: userId } : { sessionCartId: sessionCartId },
  });

  if (!cart) return undefined;

  // Convert Decimal values to strings
  return convertToPlainObject({
    ...cart,
    items: cart.items as CartItem[],
    itemsPrice: cart.itemsPrice.toString(),
    totalPrice: cart.totalPrice.toString(),
    shippingPrice: cart.shippingPrice.toString(),
    taxPrice: cart.taxPrice.toString(),
  });
}

// Remove item from cart in database
export async function removeItemFromCart(productId: string) {
  try {
    // Get session cart id
    const sessionCartId = (await cookies()).get("sessionCartId")?.value;
    if (!sessionCartId) throw new Error("Cart Session not found");

    // Get product
    const product = await prisma.product.findFirst({
      where: { id: productId },
    });
    if (!product) throw new Error("Product not found");

    // Get user cart
    const cart = await getMyCart();
    if (!cart) throw new Error("Cart not found");

    // Check if cart has item
    const exist = (cart.items as CartItem[]).find(
      (x) => x.productId === productId
    );
    if (!exist) throw new Error("Item not found");

    // Check if cart has only one item
    if (exist.qty === 1) {
      // Remove item from cart
      cart.items = (cart.items as CartItem[]).filter(
        (x) => x.productId !== exist.productId
      );
    } else {
      // Decrease quantity of existing item
      (cart.items as CartItem[]).find((x) => x.productId === productId)!.qty =
        exist.qty - 1;
    }

    // Update cart in database
    await prisma.cart.update({
      where: { id: cart.id },
      data: {
        items: cart.items as Prisma.CartUpdateitemsInput[],
        ...calcPrice(cart.items as CartItem[]),
      },
    });

    // Revalidate product page
    revalidatePath(`/product/${product.slug}`);

    return {
      success: true,
      message: `${product.name}  ${
        (cart.items as CartItem[]).find((x) => x.productId === productId)
          ? "updated in"
          : "removed from"
      } cart successfully`,
    };
  } catch (error) {
    return { success: false, message: formatError(error) };
  }
}
