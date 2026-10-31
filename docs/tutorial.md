# Tutorial: your first diagram in 15 minutes

In this tutorial you build an order-fulfilment process step by step: a
customer orders, the company checks credit, picks and ships the goods, and
a bank takes part in payment. Each step adds one idea and shows the diagram
it produces.

You need either the [web editor](../apps/editor/README.md) (nothing to
install) or the command line, installed from a release:

```bash
npm install -g ./bpmn-text-<version>.tgz
```

With the command line, save each step as `order.bpmnt` and run:

```bash
bpmn-text build order.bpmnt -o order.bpmn          # open in Camunda Modeler or bpmn.io
bpmn-text build order.bpmnt -f svg -o order.svg    # or look at a picture
```

## Step 1: steps in story order (2 minutes)

Write the steps in the order they happen, one per line. Every step flows
into the next one: you never draw an arrow for the normal sequence.

<!-- screenshot: tutorial-1 -->

```bpmnt
title "Order fulfilment"

start Order received
task Check credit
task Pick items
task Ship parcel
end Shipped
```

![Step 1](images/tutorial-1.png)

`start` and `end` are events, `task` is an activity. More specific kinds of
task exist, such as `user`, `service`, `send` and `receive`; they only
change the icon. Try changing `task Check credit` to `service Check
credit`.

## Step 2: a decision (3 minutes)

A gateway is followed by an indented block of branches. Each branch is
`label:` and then its steps, on the same line or indented below.

<!-- screenshot: tutorial-2 -->

```bpmnt
title "Order fulfilment"

start Order received
task Check credit
xor Credit OK?
  yes:
    task Pick items
  no:
    task Request prepayment
    task Receive payment
task Ship parcel
end Shipped
```

![Step 2](images/tutorial-2.png)

Both branches end open, so they **merge automatically** into the next step,
`Ship parcel`, through an inserted exclusive gateway. You did not have to
name or draw the merge.

> **Note:** a branch that ends with `end …` does not merge: it finishes the
> process there. Try changing the `no:` branch to `no: end Rejected`.

## Step 3: who does what (3 minutes)

Put the process in a pool and split it into lanes. `lane X` switches the
current lane: every following step goes into lane X until the next switch.
The flow still reads as one story across lanes.

<!-- screenshot: tutorial-3 -->

```bpmnt
title "Order fulfilment"

pool Company
  lane Sales
  start Order received
  task Check credit
  xor Credit OK?
    yes:
      lane Warehouse
      task Pick items
    no:
      task Request prepayment
      task Receive payment
  lane Warehouse
  task Ship parcel
  end Shipped
```

![Step 3](images/tutorial-3.png)

A lane switch inside a branch lasts only until the end of that branch, so
the `no:` branch stays in Sales. That is why `lane Warehouse` is needed
again before `Ship parcel`.

## Step 4: talking to the customer (4 minutes)

A second pool makes the diagram a collaboration. `~>` draws a message flow
between pools; it never changes the sequence flow. The target can be
declared later in the file.

<!-- screenshot: tutorial-4 -->

```bpmnt
title "Order fulfilment"

pool Customer
  start Need product
  send Place order ~> Order received
  receive Confirmation
  end Done

pool Company
  lane Sales
  start message Order received
  task Check credit
  xor Credit OK?
    yes:
      lane Warehouse
      task Pick items
    no:
      send Request prepayment ~> Bank
      receive Payment received
  lane Warehouse
  task Ship parcel
  send Send confirmation ~> Confirmation
  end Shipped

pool Bank [collapsed]
Bank ~> Payment received
```

![Step 4](images/tutorial-4.png)

`pool Bank [collapsed]` is a black box: a partner whose inside you do not
model. Message flows can start or end at the pool itself, as in the last
line.

## Step 5: loops and jumps (2 minutes)

To go anywhere other than the next line, write `-> Name`. Names are
references: you do not need IDs.

<!-- screenshot: tutorial-5 -->

```bpmnt
title "Order fulfilment"

start Order received
task Check order
xor Order complete?
  yes:
    task Ship parcel
  no:
    task Ask customer for details
    -> Check order
end Shipped
```

![Step 5](images/tutorial-5.png)

A line that ends with a jump does not continue to the next line, so the
`no:` branch is not merged into `Shipped`: it loops back instead.

## Step 6: check and tidy (1 minute)

The compiler explains mistakes with a line, a column and, where it can, a
fix. Misspell a reference, for example `-> Chek order`, and run:

```bash
bpmn-text check order.bpmnt
```

```text
error[BT202]: Nothing is called `Chek order`. Did you mean `Check order`?
 --> order.bpmnt:10:8
```

The web editor underlines the same mistake as you type and offers the fix.
When the file is right, `bpmn-text fmt order.bpmnt` rewrites it in
canonical style.

## What next

- The [cookbook](cookbook.md) has recipes for common patterns and errors.
- The [notation reference](notation.md) describes every statement.
- The [examples](../examples) show complete processes, from a simple one to
  a [multi-phase process with eight lanes](../examples/07-multi-phase.bpmnt).
